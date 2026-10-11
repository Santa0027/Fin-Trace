-- Patch for databases bootstrapped before this was added to schema.sql.
-- Run as the schema owner (fintrace_owner). Safe to run more than once.

BEGIN;

-- -----------------------------------------------------------------------------
-- Workspace timezone, and loan balances that follow ledger reversals
-- -----------------------------------------------------------------------------
-- Calendar days (report periods, "this month") are the workspace's local days.
ALTER TABLE fintrace.tenants
    ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'UTC';

CREATE OR REPLACE FUNCTION fintrace.validate_tenant_timezone()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
        RAISE EXCEPTION 'Unknown timezone %', NEW.timezone USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_timezone_validate ON fintrace.tenants;
CREATE TRIGGER tenants_timezone_validate
BEFORE INSERT OR UPDATE OF timezone ON fintrace.tenants
FOR EACH ROW EXECUTE FUNCTION fintrace.validate_tenant_timezone();

-- A repayment row is immutable history. When its ledger transaction is reversed,
-- the repayment stops counting: the ledger, not a flag on the row, decides.
CREATE OR REPLACE FUNCTION fintrace.debt_repayment_is_effective(p_tenant_id UUID, p_ledger_transaction_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_transactions rev
         WHERE rev.tenant_id = p_tenant_id
           AND rev.reverses_transaction_id = p_ledger_transaction_id
           AND rev.status = 'COMPLETED'
    );
$$;

CREATE OR REPLACE VIEW fintrace.debt_balances
WITH (security_invoker = true) AS
SELECT
    d.id AS debt_id,
    d.tenant_id,
    d.type,
    d.contact_id,
    d.principal_amount,
    COALESCE(sum(r.principal_amount),0) AS repaid_principal,
    d.principal_amount - COALESCE(sum(r.principal_amount),0) AS outstanding_principal,
    d.currency_id,
    d.status,
    d.start_date,
    d.due_date
FROM fintrace.debts d
LEFT JOIN fintrace.debt_repayments r
       ON r.tenant_id = d.tenant_id AND r.debt_id = d.id
      AND fintrace.debt_repayment_is_effective(r.tenant_id, r.ledger_transaction_id)
WHERE d.tenant_id = fintrace.current_tenant_id()
GROUP BY d.id, d.tenant_id, d.type, d.contact_id,
         d.principal_amount, d.currency_id, d.status, d.start_date, d.due_date;

CREATE OR REPLACE FUNCTION fintrace.validate_debt_status(p_debt_id UUID, p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
    v_principal NUMERIC(28,8);
    v_repaid_principal NUMERIC(38,8);
    v_outstanding NUMERIC(38,8);
BEGIN
    SELECT status, principal_amount
      INTO v_status, v_principal
      FROM fintrace.debts
     WHERE tenant_id = p_tenant_id AND id = p_debt_id;

    IF v_principal IS NULL THEN
        RETURN;
    END IF;

    SELECT COALESCE(sum(principal_amount),0)
      INTO v_repaid_principal
      FROM fintrace.debt_repayments r
     WHERE r.tenant_id = p_tenant_id AND r.debt_id = p_debt_id
       AND fintrace.debt_repayment_is_effective(r.tenant_id, r.ledger_transaction_id);

    v_outstanding := v_principal - v_repaid_principal;

    IF v_outstanding < 0 THEN
        RAISE EXCEPTION 'Debt % has repayments exceeding principal', p_debt_id
            USING ERRCODE = '23514';
    END IF;

    IF v_status = 'PAID' AND v_outstanding <> 0 THEN
        RAISE EXCEPTION 'Debt % cannot be PAID while principal outstanding is %', p_debt_id, v_outstanding
            USING ERRCODE = '23514';
    END IF;

    IF v_status = 'ACTIVE' AND v_outstanding = 0 THEN
        RAISE EXCEPTION 'Debt % should be PAID once principal outstanding reaches zero', p_debt_id
            USING ERRCODE = '23514';
    END IF;
END;
$$;

-- Sign-in also needs the workspace timezone; the return type changes, so recreate.
DROP FUNCTION IF EXISTS fintrace.list_user_tenants(UUID, BOOLEAN);
CREATE FUNCTION fintrace.list_user_tenants(
    p_user_id UUID,
    p_platform_admin BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    id UUID, slug VARCHAR, name VARCHAR, status VARCHAR, is_member BOOLEAN,
    base_currency_id UUID, base_currency_code VARCHAR, base_currency_symbol VARCHAR, base_currency_decimals SMALLINT,
    timezone VARCHAR
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
    SELECT t.id, t.slug, t.name, t.status, (m.id IS NOT NULL) AS is_member,
           c.id, c.code, c.symbol, c.decimal_places, t.timezone
      FROM fintrace.tenants t
      JOIN fintrace.currencies c ON c.id = t.base_currency_id
      LEFT JOIN fintrace.tenant_memberships m
             ON m.tenant_id = t.id
            AND m.user_id = p_user_id
            AND m.status = 'ACTIVE'
     WHERE t.status = 'ACTIVE'
       AND EXISTS (SELECT 1 FROM fintrace.users u WHERE u.id = p_user_id AND u.status = 'ACTIVE')
       AND (m.id IS NOT NULL OR COALESCE(p_platform_admin, FALSE))
     ORDER BY (m.id IS NOT NULL) DESC, t.name, t.id;
$$;

REVOKE ALL ON FUNCTION fintrace.list_user_tenants(UUID, BOOLEAN) FROM PUBLIC;

COMMIT;
