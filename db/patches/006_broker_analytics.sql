-- Patch for databases bootstrapped before this was added to schema.sql.
-- Run as the schema owner (fintrace_owner). Safe to run more than once.

BEGIN;

-- -----------------------------------------------------------------------------
-- Broker analytics: cash, SIPs, open positions and per-holding history
-- -----------------------------------------------------------------------------
ALTER TABLE fintrace.broker_connections
    ADD COLUMN IF NOT EXISTS cash_available NUMERIC(19,2) NULL;

CREATE TABLE IF NOT EXISTS fintrace.broker_positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    symbol VARCHAR(100) NOT NULL,
    exchange VARCHAR(20) NOT NULL DEFAULT '',
    product VARCHAR(20) NOT NULL DEFAULT '',
    quantity NUMERIC(24,6) NOT NULL,
    average_price NUMERIC(19,6) NOT NULL DEFAULT 0,
    last_price NUMERIC(19,6) NOT NULL DEFAULT 0,
    pnl NUMERIC(19,2) NOT NULL DEFAULT 0,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT broker_positions_connection_fk FOREIGN KEY (tenant_id, connection_id)
        REFERENCES fintrace.broker_connections(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fintrace.broker_sips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    sip_id VARCHAR(50) NOT NULL DEFAULT '',
    fund VARCHAR(255) NOT NULL DEFAULT '',
    symbol VARCHAR(100) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT '',
    frequency VARCHAR(20) NOT NULL DEFAULT '',
    instalment_amount NUMERIC(19,2) NOT NULL DEFAULT 0,
    instalment_day INTEGER NULL,
    next_instalment DATE NULL,
    completed_instalments INTEGER NOT NULL DEFAULT 0,
    -- -1 means the SIP runs until cancelled
    pending_instalments INTEGER NOT NULL DEFAULT -1,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT broker_sips_connection_fk FOREIGN KEY (tenant_id, connection_id)
        REFERENCES fintrace.broker_connections(tenant_id, id) ON DELETE CASCADE
);

-- One row per holding per day synced, so each holding's value can be followed over time.
CREATE TABLE IF NOT EXISTS fintrace.broker_holding_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    snapshot_date DATE NOT NULL,
    asset_class VARCHAR(20) NOT NULL,
    symbol VARCHAR(100) NOT NULL,
    folio VARCHAR(50) NOT NULL DEFAULT '',
    quantity NUMERIC(24,6) NOT NULL,
    invested_value NUMERIC(19,2) NOT NULL,
    current_value NUMERIC(19,2) NOT NULL,
    CONSTRAINT broker_holding_snapshots_connection_fk FOREIGN KEY (tenant_id, connection_id)
        REFERENCES fintrace.broker_connections(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT broker_holding_snapshots_day_uk UNIQUE (tenant_id, connection_id, snapshot_date, asset_class, symbol, folio)
);

CREATE INDEX IF NOT EXISTS broker_positions_connection_idx ON fintrace.broker_positions(tenant_id, connection_id);
CREATE INDEX IF NOT EXISTS broker_sips_connection_idx ON fintrace.broker_sips(tenant_id, connection_id);

ALTER TABLE fintrace.broker_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.broker_sips ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.broker_holding_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['broker_positions','broker_sips','broker_holding_snapshots'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON fintrace.%I', t || '_select', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON fintrace.%I', t || '_write', t);
        EXECUTE format(
            'CREATE POLICY %I ON fintrace.%I FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND (SELECT fintrace.has_permission(''investments.view'')))',
            t || '_select', t);
        EXECUTE format(
            'CREATE POLICY %I ON fintrace.%I FOR ALL USING (tenant_id = fintrace.current_tenant_id() AND (SELECT fintrace.has_permission(''investments.update''))) WITH CHECK (tenant_id = fintrace.current_tenant_id() AND (SELECT fintrace.has_permission(''investments.update'')))',
            t || '_write', t);
    END LOOP;
END;
$$;

COMMIT;
