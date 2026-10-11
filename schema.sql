-- Fintrace Standalone Production PostgreSQL Schema
-- PostgreSQL 16+
-- IMPORTANT: run fintrace_role_hardening.sql after this schema and before assigning a runtime login.
--
-- Architectural goals:
--   * hard tenant isolation with composite tenant-aware foreign keys
--   * PostgreSQL Row Level Security (RLS) and RBAC integrated as defense in depth
--   * immutable double-entry ledger after posting with tolerance-based rounding
--   * reversal-based financial corrections
--   * explicit multi-currency accounting
--   * page/action RBAC with role grants and per-user ALLOW/DENY overrides
--   * append-only audit trail with strict actor accountability and JSONB indexing
--   * idempotent API operation storage with recovery metadata and prune routines
--   * no soft-delete on the financial ledger (archival defenses applied)
--   * derived views for balances, debt outstanding, goals and valuations
--   * history tables instead of mutable financial snapshots where practical
--
-- -----------------------------------------------------------------------------

BEGIN;



CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS fintrace;
SET search_path = fintrace, public;

-- -----------------------------------------------------------------------------
-- Session context / common helpers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.current_tenant_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
    SELECT NULLIF(current_setting('fintrace.current_tenant_id', true), '')::UUID;
$$;

CREATE OR REPLACE FUNCTION fintrace.current_user_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
    SELECT NULLIF(current_setting('fintrace.current_user_id', true), '')::UUID;
$$;

CREATE OR REPLACE FUNCTION fintrace.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.assert_not_null_uuid(p_value UUID, p_message TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF p_value IS NULL THEN
        RAISE EXCEPTION '%', p_message USING ERRCODE = '23502';
    END IF;
    RETURN p_value;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.set_context(p_user_id UUID, p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM fintrace.users u
          JOIN fintrace.tenant_memberships m ON m.user_id = u.id
         WHERE u.id = p_user_id
           AND u.status = 'ACTIVE'
           AND m.tenant_id = p_tenant_id
           AND m.status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'User is not an active member of the requested tenant'
            USING ERRCODE = '42501';
    END IF;

    PERFORM set_config('fintrace.current_user_id', p_user_id::TEXT, true);
    PERFORM set_config('fintrace.current_tenant_id', p_tenant_id::TEXT, true);
END;
$$;

SET LOCAL check_function_bodies = off;

CREATE OR REPLACE FUNCTION fintrace.has_permission(
    p_permission_code TEXT,
    p_required_scope TEXT DEFAULT 'TENANT'
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
WITH m AS (
    SELECT tm.id
      FROM fintrace.tenant_memberships tm
     WHERE tm.tenant_id = fintrace.current_tenant_id()
       AND tm.user_id = fintrace.current_user_id()
       AND tm.status = 'ACTIVE'
),
override AS (
    SELECT o.effect, o.access_scope
      FROM fintrace.rbac_user_permission_overrides o
      JOIN m ON m.id = o.membership_id
      JOIN fintrace.rbac_permissions p ON p.id = o.permission_id
     WHERE p.code = p_permission_code
       AND (o.expires_at IS NULL OR o.expires_at > clock_timestamp())
)
SELECT CASE
    WHEN EXISTS (SELECT 1 FROM override WHERE effect = 'DENY') THEN FALSE
    WHEN EXISTS (
        SELECT 1 FROM override
         WHERE effect = 'ALLOW'
           AND (p_required_scope = 'OWN' OR access_scope = p_required_scope)
    ) THEN TRUE
    ELSE EXISTS (
        SELECT 1
          FROM m
          JOIN fintrace.rbac_membership_roles mr ON mr.membership_id = m.id
          JOIN fintrace.rbac_roles r ON r.id = mr.role_id
          JOIN fintrace.rbac_role_permissions rp ON rp.role_id = r.id
          JOIN fintrace.rbac_permissions p ON p.id = rp.permission_id
         WHERE r.is_active
           AND p.is_active
           AND p.code = p_permission_code
           AND (r.tenant_id IS NULL OR r.tenant_id = fintrace.current_tenant_id())
           AND (p_required_scope = 'OWN' OR rp.access_scope = p_required_scope)
    )
END;
$$;
SET LOCAL check_function_bodies = on;

-- -----------------------------------------------------------------------------
-- Global reference data
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.currencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(3) NOT NULL,
    name VARCHAR(100) NOT NULL,
    symbol VARCHAR(10) NOT NULL DEFAULT '',
    decimal_places SMALLINT NOT NULL DEFAULT 2,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT currencies_code_uk UNIQUE (code),
    CONSTRAINT currencies_code_ck CHECK (code ~ '^[A-Z]{3}$'),
    CONSTRAINT currencies_decimal_places_ck CHECK (decimal_places BETWEEN 0 AND 8)
);

CREATE INDEX IF NOT EXISTS currencies_active_idx
    ON fintrace.currencies(is_active);

-- -----------------------------------------------------------------------------
-- Identity and tenants
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(150) NOT NULL,
    email VARCHAR(254) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(150) NOT NULL DEFAULT '',
    last_name VARCHAR(150) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    is_staff BOOLEAN NOT NULL DEFAULT FALSE,
    is_superuser BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT users_status_ck CHECK (status IN ('ACTIVE','DISABLED','LOCKED')),
    CONSTRAINT users_username_nonempty_ck CHECK (length(btrim(username)) > 0),
    CONSTRAINT users_email_nonempty_ck CHECK (length(btrim(email)) > 0),
    CONSTRAINT users_password_hash_nonempty_ck CHECK (length(password_hash) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uk
    ON fintrace.users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uk
    ON fintrace.users (lower(email));

CREATE TABLE IF NOT EXISTS fintrace.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(80) NOT NULL,
    name VARCHAR(255) NOT NULL,
    owner_id UUID NOT NULL,
    base_currency_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT tenants_slug_uk UNIQUE (slug),
    CONSTRAINT tenants_slug_format_ck CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    CONSTRAINT tenants_name_nonempty_ck CHECK (length(btrim(name)) > 0),
    CONSTRAINT tenants_status_ck CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
    CONSTRAINT tenants_owner_fk FOREIGN KEY (owner_id)
        REFERENCES fintrace.users(id) ON DELETE RESTRICT,
    CONSTRAINT tenants_currency_fk FOREIGN KEY (base_currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS tenants_owner_idx
    ON fintrace.tenants(owner_id);
CREATE INDEX IF NOT EXISTS tenants_status_idx
    ON fintrace.tenants(status);

-- -----------------------------------------------------------------------------
-- RBAC catalog
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.rbac_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(100) NOT NULL,
    name VARCHAR(150) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT rbac_pages_code_uk UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS fintrace.rbac_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT rbac_actions_code_uk UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS fintrace.rbac_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID NOT NULL,
    action_id UUID NOT NULL,
    code VARCHAR(160) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT rbac_permissions_code_uk UNIQUE (code),
    CONSTRAINT rbac_permissions_page_action_uk UNIQUE (page_id, action_id),
    CONSTRAINT rbac_permissions_page_fk FOREIGN KEY (page_id)
        REFERENCES fintrace.rbac_pages(id) ON DELETE RESTRICT,
    CONSTRAINT rbac_permissions_action_fk FOREIGN KEY (action_id)
        REFERENCES fintrace.rbac_actions(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS fintrace.rbac_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NULL,
    code VARCHAR(100) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT rbac_roles_tenant_id_code_uk UNIQUE (tenant_id, code),
    CONSTRAINT rbac_roles_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT rbac_roles_global_system_ck CHECK (
        (tenant_id IS NULL AND is_system = TRUE)
        OR
        (tenant_id IS NOT NULL AND is_system = FALSE)
    ),
    CONSTRAINT rbac_roles_reserved_code_ck CHECK (
        tenant_id IS NULL OR upper(code) NOT IN ('ADMIN','MEMBER','VIEWER')
    )
);

CREATE INDEX IF NOT EXISTS rbac_roles_tenant_idx
    ON fintrace.rbac_roles(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS rbac_roles_global_code_uk
    ON fintrace.rbac_roles(code)
    WHERE tenant_id IS NULL;

CREATE TABLE IF NOT EXISTS fintrace.tenant_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'INVITED',
    invited_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    joined_at TIMESTAMPTZ NULL,
    left_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT tenant_memberships_tenant_user_uk UNIQUE (tenant_id, user_id),
    CONSTRAINT tenant_memberships_tenant_id_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT tenant_memberships_user_id_fk FOREIGN KEY (user_id)
        REFERENCES fintrace.users(id) ON DELETE RESTRICT,
    CONSTRAINT tenant_memberships_status_ck CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','LEFT')),
    CONSTRAINT tenant_memberships_dates_ck CHECK (
        joined_at IS NULL OR joined_at >= invited_at
    ),
    CONSTRAINT tenant_memberships_lifecycle_ck CHECK (
        (status = 'INVITED' AND joined_at IS NULL AND left_at IS NULL)
        OR
        (status IN ('ACTIVE','SUSPENDED') AND joined_at IS NOT NULL AND left_at IS NULL)
        OR
        (status = 'LEFT' AND joined_at IS NOT NULL AND left_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS tenant_memberships_tenant_status_idx
    ON fintrace.tenant_memberships(tenant_id, status);
CREATE INDEX IF NOT EXISTS tenant_memberships_user_idx
    ON fintrace.tenant_memberships(user_id);


CREATE INDEX IF NOT EXISTS rbac_permissions_page_action_idx ON fintrace.rbac_permissions(page_id, action_id);

CREATE TABLE IF NOT EXISTS fintrace.rbac_role_permissions (
    role_id UUID NOT NULL,
    permission_id UUID NOT NULL,
    access_scope VARCHAR(20) NOT NULL DEFAULT 'TENANT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (role_id, permission_id),
    CONSTRAINT rbac_role_permissions_role_fk FOREIGN KEY (role_id)
        REFERENCES fintrace.rbac_roles(id) ON DELETE RESTRICT,
    CONSTRAINT rbac_role_permissions_permission_fk FOREIGN KEY (permission_id)
        REFERENCES fintrace.rbac_permissions(id) ON DELETE RESTRICT,
    CONSTRAINT rbac_role_permissions_scope_ck CHECK (access_scope IN ('TENANT','OWN'))
);

CREATE TABLE IF NOT EXISTS fintrace.rbac_membership_roles (
    membership_id UUID NOT NULL,
    role_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (membership_id, role_id),
    CONSTRAINT rbac_membership_roles_membership_fk FOREIGN KEY (membership_id)
        REFERENCES fintrace.tenant_memberships(id) ON DELETE RESTRICT,
    CONSTRAINT rbac_membership_roles_role_fk FOREIGN KEY (role_id)
        REFERENCES fintrace.rbac_roles(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS fintrace.rbac_user_permission_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id UUID NOT NULL,
    permission_id UUID NOT NULL,
    effect VARCHAR(10) NOT NULL,
    access_scope VARCHAR(20) NOT NULL DEFAULT 'TENANT',
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT rbac_user_permission_override_uk UNIQUE (membership_id, permission_id),
    CONSTRAINT rbac_user_permission_overrides_membership_fk FOREIGN KEY (membership_id)
        REFERENCES fintrace.tenant_memberships(id) ON DELETE RESTRICT,
    CONSTRAINT rbac_user_permission_overrides_permission_fk FOREIGN KEY (permission_id)
        REFERENCES fintrace.rbac_permissions(id) ON DELETE RESTRICT,
    CONSTRAINT rbac_user_permission_overrides_effect_ck CHECK (effect IN ('ALLOW','DENY')),
    CONSTRAINT rbac_user_permission_overrides_scope_ck CHECK (access_scope IN ('TENANT','OWN')),
    CONSTRAINT rbac_user_permission_overrides_expiry_ck CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS rbac_membership_roles_role_idx
    ON fintrace.rbac_membership_roles(role_id);
CREATE INDEX IF NOT EXISTS rbac_user_permission_overrides_expiry_idx
    ON fintrace.rbac_user_permission_overrides(expires_at);

-- -----------------------------------------------------------------------------
-- Idempotency and audit
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.idempotency_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NULL,
    operation_scope VARCHAR(150) NOT NULL,
    operation_key VARCHAR(255) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
    response_status SMALLINT NULL,
    response_payload JSONB NULL,
    operation_id UUID NULL,
    locked_until TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    failure_reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT idempotency_tenant_scope_key_uk UNIQUE (tenant_id, operation_scope, operation_key),
    CONSTRAINT idempotency_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT idempotency_user_fk FOREIGN KEY (user_id)
        REFERENCES fintrace.users(id) ON DELETE RESTRICT,
    CONSTRAINT idempotency_operation_id_uk UNIQUE (operation_id),
    CONSTRAINT idempotency_fingerprint_ck CHECK (request_fingerprint ~ '^[0-9a-fA-F]{64}$'),
    CONSTRAINT idempotency_status_ck CHECK (status IN ('PROCESSING','COMPLETED','FAILED','EXPIRED')),
    CONSTRAINT idempotency_response_status_ck CHECK (
        response_status IS NULL OR response_status BETWEEN 100 AND 599
    ),
    CONSTRAINT idempotency_completed_ck CHECK (
        (status = 'COMPLETED' AND completed_at IS NOT NULL)
        OR
        (status <> 'COMPLETED')
    ),
    CONSTRAINT idempotency_expiry_ck CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idempotency_tenant_status_idx
    ON fintrace.idempotency_operations(tenant_id, status);
CREATE INDEX IF NOT EXISTS idempotency_locked_until_idx
    ON fintrace.idempotency_operations(locked_until);
CREATE INDEX IF NOT EXISTS idempotency_expires_idx
    ON fintrace.idempotency_operations(expires_at);

-- Cleanup Procedure for Idempotency
CREATE OR REPLACE PROCEDURE fintrace.prune_expired_idempotency_operations(p_batch_size INT DEFAULT 5000)
LANGUAGE plpgsql
AS $$
BEGIN
    WITH expired AS (
        SELECT id FROM fintrace.idempotency_operations
         WHERE expires_at < clock_timestamp()
         LIMIT p_batch_size
           FOR UPDATE SKIP LOCKED
    )
    DELETE FROM fintrace.idempotency_operations
     WHERE id IN (SELECT id FROM expired);
END;
$$;

CREATE TABLE IF NOT EXISTS fintrace.audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    actor_user_id UUID NOT NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(120) NOT NULL,
    entity_id UUID NULL,
    request_id UUID NULL,
    before_data JSONB NULL,
    after_data JSONB NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    ip_address INET NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT audit_events_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT audit_events_actor_fk FOREIGN KEY (actor_user_id)
        REFERENCES fintrace.users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS audit_events_tenant_occurred_idx
    ON fintrace.audit_events(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx
    ON fintrace.audit_events(tenant_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_events_request_idx
    ON fintrace.audit_events(request_id);
CREATE INDEX IF NOT EXISTS audit_events_before_data_gin_idx 
    ON fintrace.audit_events USING gin (before_data);
CREATE INDEX IF NOT EXISTS audit_events_after_data_gin_idx 
    ON fintrace.audit_events USING gin (after_data);

-- -----------------------------------------------------------------------------
-- Categories, tags, contacts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL,
    parent_id UUID NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    archived_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT categories_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT categories_tenant_name_type_uk UNIQUE (tenant_id, name, type),
    CONSTRAINT categories_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT categories_parent_fk FOREIGN KEY (tenant_id, parent_id)
        REFERENCES fintrace.categories(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT categories_type_ck CHECK (type IN ('INCOME','EXPENSE','TRANSFER','OTHER')),
    CONSTRAINT categories_name_nonempty_ck CHECK (length(btrim(name)) > 0),
    CONSTRAINT categories_not_own_parent_ck CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS categories_tenant_type_idx
    ON fintrace.categories(tenant_id, type, is_active);
CREATE INDEX IF NOT EXISTS categories_parent_idx
    ON fintrace.categories(tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS fintrace.tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name VARCHAR(50) NOT NULL,
    color VARCHAR(7) NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    archived_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT tags_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT tags_tenant_name_uk UNIQUE (tenant_id, name),
    CONSTRAINT tags_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT tags_color_ck CHECK (color = '' OR color ~ '^#[0-9A-Fa-f]{6}$'),
    CONSTRAINT tags_name_nonempty_ck CHECK (length(btrim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS tags_tenant_active_idx
    ON fintrace.tags(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS fintrace.contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(254) NULL,
    phone VARCHAR(50) NULL,
    notes TEXT NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT contacts_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT contacts_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT contacts_status_ck CHECK (status IN ('ACTIVE','ARCHIVED')),
    CONSTRAINT contacts_name_nonempty_ck CHECK (length(btrim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS contacts_tenant_name_idx
    ON fintrace.contacts(tenant_id, name);
CREATE INDEX IF NOT EXISTS contacts_email_idx
    ON fintrace.contacts(tenant_id, lower(email));

-- -----------------------------------------------------------------------------
-- Accounts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(30) NOT NULL,
    normal_balance VARCHAR(10) NOT NULL,
    institution VARCHAR(255) NOT NULL DEFAULT '',
    account_number VARCHAR(100) NOT NULL DEFAULT '',
    currency_id UUID NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMPTZ NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT accounts_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT accounts_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT accounts_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT accounts_type_ck CHECK (type IN (
        'BANK','CASH','CREDIT_CARD','WALLET','BROKER','INVESTMENT',
        'INCOME','EXPENSE','LIABILITY','EQUITY','FOREX','OTHER'
    )),
    CONSTRAINT accounts_normal_balance_ck CHECK (normal_balance IN ('DEBIT','CREDIT')),
    CONSTRAINT accounts_system_name_ck CHECK (is_system OR length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_tenant_account_number_uk
    ON fintrace.accounts(tenant_id, account_number)
    WHERE account_number <> '' AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS accounts_tenant_type_idx
    ON fintrace.accounts(tenant_id, type, is_active);
CREATE INDEX IF NOT EXISTS accounts_tenant_currency_idx
    ON fintrace.accounts(tenant_id, currency_id);

-- -----------------------------------------------------------------------------
-- Ledger: the financial source of truth
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    reference VARCHAR(255) NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    reverses_transaction_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ledger_transactions_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT ledger_transactions_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT ledger_transactions_reversal_fk FOREIGN KEY (tenant_id, reverses_transaction_id)
        REFERENCES fintrace.ledger_transactions(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT ledger_transactions_status_ck CHECK (
        status IN ('PENDING','COMPLETED','FAILED','CANCELLED')
    ),
    CONSTRAINT ledger_transactions_not_self_reverse_ck CHECK (
        reverses_transaction_id IS NULL OR reverses_transaction_id <> id
    )
);

CREATE INDEX IF NOT EXISTS ledger_transactions_tenant_date_idx
    ON fintrace.ledger_transactions(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ledger_transactions_tenant_status_idx
    ON fintrace.ledger_transactions(tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_transactions_one_reversal_uk
    ON fintrace.ledger_transactions(tenant_id, reverses_transaction_id)
    WHERE reverses_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fintrace.ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    transaction_id UUID NOT NULL,
    account_id UUID NOT NULL,
    amount NUMERIC(19,4) NOT NULL,
    debit_amount NUMERIC(19,4) NOT NULL DEFAULT 0,
    credit_amount NUMERIC(19,4) NOT NULL DEFAULT 0,
    currency_id UUID NOT NULL,
    exchange_rate NUMERIC(19,10) NOT NULL DEFAULT 1,
    base_amount NUMERIC(19,4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ledger_entries_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT ledger_entries_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT ledger_entries_transaction_fk FOREIGN KEY (tenant_id, transaction_id)
        REFERENCES fintrace.ledger_transactions(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT ledger_entries_account_fk FOREIGN KEY (tenant_id, account_id)
        REFERENCES fintrace.accounts(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT ledger_entries_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT ledger_entries_amount_ck CHECK (amount > 0),
    CONSTRAINT ledger_entries_side_nonnegative_ck CHECK (
        debit_amount >= 0 AND credit_amount >= 0
    ),
    CONSTRAINT ledger_entries_one_side_ck CHECK (
        (debit_amount > 0 AND credit_amount = 0)
        OR
        (debit_amount = 0 AND credit_amount > 0)
    ),
    CONSTRAINT ledger_entries_amount_consistency_ck CHECK (
        amount = debit_amount + credit_amount
    ),
    CONSTRAINT ledger_entries_exchange_rate_ck CHECK (exchange_rate > 0),
    CONSTRAINT ledger_entries_base_amount_ck CHECK (base_amount > 0),
    CONSTRAINT ledger_entries_base_round_ck CHECK (
        abs(base_amount - round(amount * exchange_rate, 4)) <= 0.01
    )
);

CREATE INDEX IF NOT EXISTS ledger_entries_tenant_transaction_idx
    ON fintrace.ledger_entries(tenant_id, transaction_id);
CREATE INDEX IF NOT EXISTS ledger_entries_tenant_account_created_idx
    ON fintrace.ledger_entries(tenant_id, account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_entries_currency_idx
    ON fintrace.ledger_entries(currency_id);

-- -----------------------------------------------------------------------------
-- Income / expense metadata layered on top of the ledger
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.income_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    ledger_transaction_id UUID NOT NULL,
    category_id UUID NOT NULL,
    contact_id UUID NULL,
    amount NUMERIC(19,4) NOT NULL,
    currency_id UUID NOT NULL,
    occurred_on DATE NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT income_records_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT income_records_tenant_transaction_uk UNIQUE (tenant_id, ledger_transaction_id),
    CONSTRAINT income_records_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT income_records_transaction_fk FOREIGN KEY (tenant_id, ledger_transaction_id)
        REFERENCES fintrace.ledger_transactions(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT income_records_category_fk FOREIGN KEY (tenant_id, category_id)
        REFERENCES fintrace.categories(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT income_records_contact_fk FOREIGN KEY (tenant_id, contact_id)
        REFERENCES fintrace.contacts(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT income_records_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT income_records_amount_ck CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS income_records_tenant_date_idx
    ON fintrace.income_records(tenant_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS income_records_category_idx
    ON fintrace.income_records(tenant_id, category_id);

CREATE TABLE IF NOT EXISTS fintrace.income_tags (
    tenant_id UUID NOT NULL,
    income_id UUID NOT NULL,
    tag_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, income_id, tag_id),
    CONSTRAINT income_tags_income_fk FOREIGN KEY (tenant_id, income_id)
        REFERENCES fintrace.income_records(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT income_tags_tag_fk FOREIGN KEY (tenant_id, tag_id)
        REFERENCES fintrace.tags(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS income_tags_tag_idx
    ON fintrace.income_tags(tenant_id, tag_id);

CREATE TABLE IF NOT EXISTS fintrace.expense_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    ledger_transaction_id UUID NOT NULL,
    category_id UUID NOT NULL,
    contact_id UUID NULL,
    amount NUMERIC(19,4) NOT NULL,
    currency_id UUID NOT NULL,
    occurred_on DATE NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT expense_records_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT expense_records_tenant_transaction_uk UNIQUE (tenant_id, ledger_transaction_id),
    CONSTRAINT expense_records_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT expense_records_transaction_fk FOREIGN KEY (tenant_id, ledger_transaction_id)
        REFERENCES fintrace.ledger_transactions(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT expense_records_category_fk FOREIGN KEY (tenant_id, category_id)
        REFERENCES fintrace.categories(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT expense_records_contact_fk FOREIGN KEY (tenant_id, contact_id)
        REFERENCES fintrace.contacts(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT expense_records_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT expense_records_amount_ck CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS expense_records_tenant_date_idx
    ON fintrace.expense_records(tenant_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS expense_records_category_idx
    ON fintrace.expense_records(tenant_id, category_id);

CREATE TABLE IF NOT EXISTS fintrace.expense_tags (
    tenant_id UUID NOT NULL,
    expense_id UUID NOT NULL,
    tag_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, expense_id, tag_id),
    CONSTRAINT expense_tags_expense_fk FOREIGN KEY (tenant_id, expense_id)
        REFERENCES fintrace.expense_records(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT expense_tags_tag_fk FOREIGN KEY (tenant_id, tag_id)
        REFERENCES fintrace.tags(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS expense_tags_tag_idx
    ON fintrace.expense_tags(tenant_id, tag_id);

-- -----------------------------------------------------------------------------
-- Debts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.debts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    type VARCHAR(20) NOT NULL,
    contact_id UUID NOT NULL,
    principal_amount NUMERIC(19,4) NOT NULL,
    currency_id UUID NOT NULL,
    interest_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
    start_date DATE NOT NULL,
    due_date DATE NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT debts_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT debts_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT debts_contact_fk FOREIGN KEY (tenant_id, contact_id)
        REFERENCES fintrace.contacts(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT debts_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT debts_type_ck CHECK (type IN ('PAYABLE','RECEIVABLE')),
    CONSTRAINT debts_principal_ck CHECK (principal_amount > 0),
    CONSTRAINT debts_interest_ck CHECK (interest_rate >= 0),
    CONSTRAINT debts_due_date_ck CHECK (due_date IS NULL OR due_date >= start_date),
    CONSTRAINT debts_status_ck CHECK (status IN ('ACTIVE','PAID','DEFAULTED')),
    CONSTRAINT debts_defaulted_requires_balance_ck CHECK (status <> 'DEFAULTED' OR principal_amount > 0)
);

CREATE INDEX IF NOT EXISTS debts_tenant_status_idx
    ON fintrace.debts(tenant_id, status);
CREATE INDEX IF NOT EXISTS debts_contact_idx
    ON fintrace.debts(tenant_id, contact_id);

CREATE TABLE IF NOT EXISTS fintrace.debt_repayments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    debt_id UUID NOT NULL,
    ledger_transaction_id UUID NOT NULL,
    principal_amount NUMERIC(19,4) NOT NULL DEFAULT 0,
    interest_amount NUMERIC(19,4) NOT NULL DEFAULT 0,
    total_amount NUMERIC(19,4) GENERATED ALWAYS AS (principal_amount + interest_amount) STORED,
    repaid_on DATE NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT debt_repayments_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT debt_repayments_tenant_transaction_uk UNIQUE (tenant_id, ledger_transaction_id),
    CONSTRAINT debt_repayments_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT debt_repayments_debt_fk FOREIGN KEY (tenant_id, debt_id)
        REFERENCES fintrace.debts(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT debt_repayments_transaction_fk FOREIGN KEY (tenant_id, ledger_transaction_id)
        REFERENCES fintrace.ledger_transactions(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT debt_repayments_principal_ck CHECK (principal_amount >= 0),
    CONSTRAINT debt_repayments_interest_ck CHECK (interest_amount >= 0),
    CONSTRAINT debt_repayments_total_ck CHECK (principal_amount + interest_amount > 0)
);

CREATE INDEX IF NOT EXISTS debt_repayments_debt_date_idx
    ON fintrace.debt_repayments(tenant_id, debt_id, repaid_on DESC);

-- -----------------------------------------------------------------------------
-- Investments
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.investment_portfolios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    currency_id UUID NOT NULL,
    broker VARCHAR(255) NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    archived_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT investment_portfolios_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT investment_portfolios_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT investment_portfolios_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS investment_portfolios_tenant_active_idx
    ON fintrace.investment_portfolios(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS fintrace.investment_instruments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NULL,
    symbol VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    instrument_type VARCHAR(30) NOT NULL,
    currency_id UUID NOT NULL,
    exchange_code VARCHAR(50) NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT investment_instruments_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT investment_instruments_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT investment_instruments_type_ck CHECK (
        instrument_type IN ('STOCK','ETF','MUTUAL_FUND','BOND','CRYPTO','FOREX','OTHER')
    ),
    CONSTRAINT investment_instruments_symbol_ck CHECK (length(btrim(symbol)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS investment_instruments_global_symbol_uk
    ON fintrace.investment_instruments(lower(symbol), lower(exchange_code))
    WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS investment_instruments_tenant_symbol_uk
    ON fintrace.investment_instruments(tenant_id, lower(symbol), lower(exchange_code))
    WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS investment_instruments_tenant_idx
    ON fintrace.investment_instruments(tenant_id);

CREATE TABLE IF NOT EXISTS fintrace.investment_positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    portfolio_id UUID NOT NULL,
    instrument_id UUID NOT NULL,
    quantity NUMERIC(24,8) NOT NULL DEFAULT 0,
    average_cost NUMERIC(19,6) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT investment_positions_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT investment_positions_unique_uk UNIQUE (tenant_id, portfolio_id, instrument_id),
    CONSTRAINT investment_positions_portfolio_fk FOREIGN KEY (tenant_id, portfolio_id)
        REFERENCES fintrace.investment_portfolios(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT investment_positions_quantity_ck CHECK (quantity >= 0),
    CONSTRAINT investment_positions_average_cost_ck CHECK (average_cost >= 0)
);

CREATE INDEX IF NOT EXISTS investment_positions_tenant_portfolio_idx
    ON fintrace.investment_positions(tenant_id, portfolio_id);
CREATE INDEX IF NOT EXISTS investment_positions_instrument_idx
    ON fintrace.investment_positions(tenant_id, instrument_id);

CREATE TABLE IF NOT EXISTS fintrace.investment_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    portfolio_id UUID NOT NULL,
    instrument_id UUID NOT NULL,
    ledger_transaction_id UUID NOT NULL,
    trade_type VARCHAR(10) NOT NULL,
    quantity NUMERIC(24,8) NOT NULL,
    price NUMERIC(19,6) NOT NULL,
    fees NUMERIC(19,4) NOT NULL DEFAULT 0,
    realized_pnl NUMERIC(19,4) NOT NULL DEFAULT 0,
    traded_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT investment_trades_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT investment_trades_transaction_uk UNIQUE (tenant_id, ledger_transaction_id),
    CONSTRAINT investment_trades_portfolio_fk FOREIGN KEY (tenant_id, portfolio_id)
        REFERENCES fintrace.investment_portfolios(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT investment_trades_transaction_fk FOREIGN KEY (tenant_id, ledger_transaction_id)
        REFERENCES fintrace.ledger_transactions(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT investment_trades_type_ck CHECK (trade_type IN ('BUY','SELL')),
    CONSTRAINT investment_trades_quantity_ck CHECK (quantity > 0),
    CONSTRAINT investment_trades_price_ck CHECK (price > 0),
    CONSTRAINT investment_trades_fees_ck CHECK (fees >= 0)
);

CREATE INDEX IF NOT EXISTS investment_trades_tenant_portfolio_date_idx
    ON fintrace.investment_trades(tenant_id, portfolio_id, traded_at DESC);
CREATE INDEX IF NOT EXISTS investment_trades_instrument_date_idx
    ON fintrace.investment_trades(tenant_id, instrument_id, traded_at DESC);

CREATE TABLE IF NOT EXISTS fintrace.investment_dividends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    portfolio_id UUID NOT NULL,
    instrument_id UUID NOT NULL,
    ledger_transaction_id UUID NOT NULL,
    amount NUMERIC(19,4) NOT NULL,
    currency_id UUID NOT NULL,
    paid_on DATE NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT investment_dividends_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT investment_dividends_transaction_uk UNIQUE (tenant_id, ledger_transaction_id),
    CONSTRAINT investment_dividends_portfolio_fk FOREIGN KEY (tenant_id, portfolio_id)
        REFERENCES fintrace.investment_portfolios(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT investment_dividends_transaction_fk FOREIGN KEY (tenant_id, ledger_transaction_id)
        REFERENCES fintrace.ledger_transactions(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT investment_dividends_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT investment_dividends_amount_ck CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS investment_dividends_portfolio_date_idx
    ON fintrace.investment_dividends(tenant_id, portfolio_id, paid_on DESC);

-- -----------------------------------------------------------------------------
-- Assets and valuation history
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(30) NOT NULL,
    purchase_value NUMERIC(19,4) NOT NULL,
    purchase_date DATE NULL,
    currency_id UUID NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    archived_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT assets_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT assets_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT assets_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT assets_type_ck CHECK (type IN ('PROPERTY','VEHICLE','GOLD','ELECTRONICS','OTHER')),
    CONSTRAINT assets_purchase_value_ck CHECK (purchase_value >= 0)
);

CREATE TABLE IF NOT EXISTS fintrace.asset_valuations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    asset_id UUID NOT NULL,
    value NUMERIC(19,4) NOT NULL,
    currency_id UUID NOT NULL,
    valued_on DATE NOT NULL,
    source VARCHAR(30) NOT NULL DEFAULT 'MANUAL',
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT asset_valuations_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT asset_valuations_asset_date_uk UNIQUE (tenant_id, asset_id, valued_on),
    CONSTRAINT asset_valuations_asset_fk FOREIGN KEY (tenant_id, asset_id)
        REFERENCES fintrace.assets(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT asset_valuations_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT asset_valuations_value_ck CHECK (value >= 0),
    CONSTRAINT asset_valuations_source_ck CHECK (source IN ('MANUAL','MARKET','APPRAISAL','IMPORT'))
);

CREATE INDEX IF NOT EXISTS asset_valuations_asset_date_idx
    ON fintrace.asset_valuations(tenant_id, asset_id, valued_on DESC);

-- -----------------------------------------------------------------------------
-- Goals and contribution history
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    target_amount NUMERIC(19,4) NOT NULL,
    currency_id UUID NOT NULL,
    target_date DATE NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS',
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT goals_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT goals_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT goals_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT goals_target_amount_ck CHECK (target_amount > 0),
    CONSTRAINT goals_status_ck CHECK (status IN ('IN_PROGRESS','ACHIEVED','ABANDONED'))
);

CREATE TABLE IF NOT EXISTS fintrace.goal_contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    goal_id UUID NOT NULL,
    ledger_transaction_id UUID NOT NULL,
    amount NUMERIC(19,4) NOT NULL,
    currency_id UUID NOT NULL,
    contributed_on DATE NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT goal_contributions_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT goal_contributions_goal_transaction_uk UNIQUE (tenant_id, goal_id, ledger_transaction_id),
    CONSTRAINT goal_contributions_transaction_uk UNIQUE (tenant_id, ledger_transaction_id),
    CONSTRAINT goal_contributions_goal_fk FOREIGN KEY (tenant_id, goal_id)
        REFERENCES fintrace.goals(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT goal_contributions_transaction_fk FOREIGN KEY (tenant_id, ledger_transaction_id)
        REFERENCES fintrace.ledger_transactions(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT goal_contributions_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT goal_contributions_amount_ck CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS goal_contributions_goal_date_idx
    ON fintrace.goal_contributions(tenant_id, goal_id, contributed_on DESC);

CREATE INDEX IF NOT EXISTS goals_tenant_status_idx
    ON fintrace.goals(tenant_id, status);

-- -----------------------------------------------------------------------------
-- Subscriptions and recurring execution
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    amount NUMERIC(19,4) NOT NULL,
    currency_id UUID NOT NULL,
    frequency VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
    start_date DATE NOT NULL,
    next_billing_date DATE NOT NULL,
    end_date DATE NULL,
    account_id UUID NULL,
    category_id UUID NULL,
    contact_id UUID NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT subscriptions_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT subscriptions_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT subscriptions_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT subscriptions_account_fk FOREIGN KEY (tenant_id, account_id)
        REFERENCES fintrace.accounts(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT subscriptions_category_fk FOREIGN KEY (tenant_id, category_id)
        REFERENCES fintrace.categories(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT subscriptions_contact_fk FOREIGN KEY (tenant_id, contact_id)
        REFERENCES fintrace.contacts(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT subscriptions_amount_ck CHECK (amount > 0),
    CONSTRAINT subscriptions_frequency_ck CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','YEARLY')),
    CONSTRAINT subscriptions_dates_ck CHECK (end_date IS NULL OR end_date >= start_date),
    CONSTRAINT subscriptions_next_date_ck CHECK (next_billing_date >= start_date)
);

CREATE INDEX IF NOT EXISTS subscriptions_due_idx
    ON fintrace.subscriptions(tenant_id, is_active, next_billing_date);

CREATE TABLE IF NOT EXISTS fintrace.recurring_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    subscription_id UUID NULL,
    transaction_type VARCHAR(20) NOT NULL,
    source_account_id UUID NULL,
    destination_account_id UUID NULL,
    amount NUMERIC(19,4) NOT NULL,
    currency_id UUID NOT NULL,
    category_id UUID NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    frequency VARCHAR(20) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NULL,
    next_run_at DATE NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT recurring_transactions_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT recurring_transactions_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT recurring_transactions_subscription_fk FOREIGN KEY (tenant_id, subscription_id)
        REFERENCES fintrace.subscriptions(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT recurring_transactions_source_fk FOREIGN KEY (tenant_id, source_account_id)
        REFERENCES fintrace.accounts(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT recurring_transactions_destination_fk FOREIGN KEY (tenant_id, destination_account_id)
        REFERENCES fintrace.accounts(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT recurring_transactions_category_fk FOREIGN KEY (tenant_id, category_id)
        REFERENCES fintrace.categories(tenant_id, id) ON DELETE SET NULL,
    CONSTRAINT recurring_transactions_currency_fk FOREIGN KEY (currency_id)
        REFERENCES fintrace.currencies(id) ON DELETE RESTRICT,
    CONSTRAINT recurring_transactions_type_ck CHECK (transaction_type IN ('INCOME','EXPENSE','TRANSFER')),
    CONSTRAINT recurring_transactions_amount_ck CHECK (amount > 0),
    CONSTRAINT recurring_transactions_frequency_ck CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','YEARLY')),
    CONSTRAINT recurring_transactions_dates_ck CHECK (end_date IS NULL OR end_date >= start_date),
    CONSTRAINT recurring_transactions_next_run_ck CHECK (next_run_at >= start_date),
    CONSTRAINT recurring_transactions_accounts_ck CHECK (
        (transaction_type = 'INCOME' AND source_account_id IS NULL AND destination_account_id IS NOT NULL)
        OR
        (transaction_type = 'EXPENSE' AND source_account_id IS NOT NULL AND destination_account_id IS NULL)
        OR
        (transaction_type = 'TRANSFER' AND source_account_id IS NOT NULL AND destination_account_id IS NOT NULL
            AND source_account_id <> destination_account_id)
    ),
    CONSTRAINT recurring_transactions_transfer_category_ck CHECK (
        transaction_type <> 'TRANSFER' OR category_id IS NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS recurring_transactions_subscription_uk
    ON fintrace.recurring_transactions(tenant_id, subscription_id)
    WHERE subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recurring_transactions_due_idx
    ON fintrace.recurring_transactions(tenant_id, is_active, next_run_at);

CREATE TABLE IF NOT EXISTS fintrace.recurring_transaction_occurrences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    recurring_transaction_id UUID NOT NULL,
    scheduled_for DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    operation_id UUID NOT NULL,
    ledger_transaction_id UUID NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ NULL,
    executed_at TIMESTAMPTZ NULL,
    failure_reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT recurring_occurrences_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT recurring_occurrences_schedule_uk UNIQUE (tenant_id, recurring_transaction_id, scheduled_for),
    CONSTRAINT recurring_occurrences_operation_uk UNIQUE (tenant_id, operation_id),
    CONSTRAINT recurring_occurrences_ledger_uk UNIQUE (tenant_id, ledger_transaction_id),
    CONSTRAINT recurring_occurrences_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT recurring_occurrences_recurring_fk FOREIGN KEY (tenant_id, recurring_transaction_id)
        REFERENCES fintrace.recurring_transactions(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT recurring_occurrences_ledger_fk FOREIGN KEY (tenant_id, ledger_transaction_id)
        REFERENCES fintrace.ledger_transactions(tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT recurring_occurrences_status_ck CHECK (
        status IN ('PENDING','PROCESSING','COMPLETED','FAILED','SKIPPED')
    ),
    CONSTRAINT recurring_occurrences_attempt_ck CHECK (attempt_count >= 0),
    CONSTRAINT recurring_occurrences_status_dates_ck CHECK (
        (status = 'COMPLETED' AND executed_at IS NOT NULL AND ledger_transaction_id IS NOT NULL)
        OR
        (status <> 'COMPLETED')
    ),
    CONSTRAINT recurring_occurrences_failed_reason_ck CHECK (
        status <> 'FAILED' OR length(btrim(failure_reason)) > 0
    )
);

CREATE INDEX IF NOT EXISTS recurring_occurrences_due_idx
    ON fintrace.recurring_transaction_occurrences(tenant_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS recurring_occurrences_processing_lock_idx
    ON fintrace.recurring_transaction_occurrences(locked_until);

CREATE OR REPLACE FUNCTION fintrace.reverse_ledger_transaction(
    p_tenant_id UUID,
    p_transaction_id UUID,
    p_occurred_at TIMESTAMPTZ DEFAULT clock_timestamp(),
    p_reference VARCHAR DEFAULT ''
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_reversal_id UUID;
BEGIN
    IF NOT fintrace.has_permission('transactions.reverse', 'TENANT') THEN
        RAISE EXCEPTION 'Permission transactions.reverse is required' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM fintrace.ledger_transactions
         WHERE tenant_id = p_tenant_id
           AND id = p_transaction_id
           AND status = 'COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Only a COMPLETED transaction may be reversed' USING ERRCODE = '23514';
    END IF;

    INSERT INTO fintrace.ledger_transactions (
        tenant_id, occurred_at, reference, description, status, reverses_transaction_id
    )
    SELECT tenant_id, p_occurred_at, p_reference, 'Reversal of transaction ' || id, 'PENDING', id
      FROM fintrace.ledger_transactions
     WHERE tenant_id = p_tenant_id AND id = p_transaction_id
    RETURNING id INTO v_reversal_id;

    INSERT INTO fintrace.ledger_entries (
        tenant_id, transaction_id, account_id, amount,
        debit_amount, credit_amount, currency_id, exchange_rate, base_amount
    )
    SELECT
        tenant_id,
        v_reversal_id,
        account_id,
        amount,
        credit_amount,
        debit_amount,
        currency_id,
        exchange_rate,
        base_amount
      FROM fintrace.ledger_entries
     WHERE tenant_id = p_tenant_id
       AND transaction_id = p_transaction_id
     ORDER BY created_at, id;

    UPDATE fintrace.ledger_transactions
       SET status = 'COMPLETED'
     WHERE tenant_id = p_tenant_id
       AND id = v_reversal_id;

    RETURN v_reversal_id;
END;
$$;

REVOKE ALL ON FUNCTION fintrace.set_context(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.has_permission(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.reverse_ledger_transaction(UUID, UUID, TIMESTAMPTZ, VARCHAR) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Domain validation triggers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.validate_ledger_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_account_currency UUID;
    v_account_active BOOLEAN;
    v_tenant_currency UUID;
    v_tx_status TEXT;
    v_tx_is_reversal BOOLEAN;
BEGIN
    SELECT a.currency_id, a.is_active
      INTO v_account_currency, v_account_active
      FROM fintrace.accounts a
     WHERE a.tenant_id = NEW.tenant_id
       AND a.id = NEW.account_id;

    IF v_account_currency IS NULL THEN
        RAISE EXCEPTION 'Account % does not belong to tenant %', NEW.account_id, NEW.tenant_id
            USING ERRCODE = '23503';
    END IF;

    SELECT reverses_transaction_id IS NOT NULL
      INTO v_tx_is_reversal
      FROM fintrace.ledger_transactions
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.transaction_id;

    IF NOT COALESCE(v_account_active, FALSE) AND NOT COALESCE(v_tx_is_reversal, FALSE) THEN
        RAISE EXCEPTION 'New ledger entries cannot use an inactive account unless the transaction is a reversal' USING ERRCODE = '23514';
    END IF;

    IF NEW.currency_id <> v_account_currency THEN
        RAISE EXCEPTION 'Ledger entry currency must equal account currency'
            USING ERRCODE = '23514';
    END IF;

    SELECT t.base_currency_id
      INTO v_tenant_currency
      FROM fintrace.tenants t
     WHERE t.id = NEW.tenant_id;

    IF NEW.currency_id = v_tenant_currency AND NEW.exchange_rate <> 1 THEN
        RAISE EXCEPTION 'Exchange rate must be 1 for tenant base currency entries'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.currency_id <> v_tenant_currency AND NEW.exchange_rate = 1 THEN
        RAISE EXCEPTION 'Non-base currency ledger entries require an explicit exchange rate'
            USING ERRCODE = '23514';
    END IF;

    SELECT status
      INTO v_tx_status
      FROM fintrace.ledger_transactions
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.transaction_id;

    IF v_tx_status IS NULL THEN
        RAISE EXCEPTION 'Ledger transaction % does not exist for tenant %', NEW.transaction_id, NEW.tenant_id
            USING ERRCODE = '23503';
    END IF;

    IF v_tx_status IN ('COMPLETED','FAILED','CANCELLED') THEN
        RAISE EXCEPTION 'Ledger entries cannot be modified after transaction is terminal'
            USING ERRCODE = '25006';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.block_ledger_entry_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status
      INTO v_status
      FROM fintrace.ledger_transactions
     WHERE tenant_id = OLD.tenant_id
       AND id = OLD.transaction_id;

    IF v_status IN ('COMPLETED','FAILED','CANCELLED') THEN
        RAISE EXCEPTION 'Ledger entries cannot be deleted after transaction is terminal'
            USING ERRCODE = '25006';
    END IF;

    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.validate_reversal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
BEGIN
    IF NEW.reverses_transaction_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT status
      INTO v_status
      FROM fintrace.ledger_transactions
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.reverses_transaction_id;

    IF v_status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'A transaction may only reverse a COMPLETED transaction'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.block_terminal_ledger_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status IN ('COMPLETED','FAILED','CANCELLED') THEN
        RAISE EXCEPTION 'Terminal ledger transactions are immutable; use a reversal or compensating transaction'
            USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.validate_completed_transaction(p_transaction_id UUID, p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
    v_line_count INTEGER;
    v_debit NUMERIC(30,4);
    v_credit NUMERIC(30,4);
BEGIN
    SELECT status INTO v_status
      FROM fintrace.ledger_transactions
     WHERE tenant_id = p_tenant_id
       AND id = p_transaction_id
       FOR UPDATE;

    IF v_status <> 'COMPLETED' THEN
        RETURN;
    END IF;

    SELECT count(*),
           COALESCE(sum(base_amount) FILTER (WHERE debit_amount > 0), 0),
           COALESCE(sum(base_amount) FILTER (WHERE credit_amount > 0), 0)
      INTO v_line_count, v_debit, v_credit
      FROM fintrace.ledger_entries
     WHERE tenant_id = p_tenant_id
       AND transaction_id = p_transaction_id;

    IF v_line_count < 2 THEN
        RAISE EXCEPTION 'Completed ledger transaction % must have at least two entries', p_transaction_id
            USING ERRCODE = '23514';
    END IF;

    IF v_debit <= 0 OR v_credit <= 0 OR abs(v_debit - v_credit) > 0.01 THEN
        RAISE EXCEPTION 'Completed ledger transaction % is not balanced in tenant base currency (debit %, credit %)',
            p_transaction_id, v_debit, v_credit
            USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.trg_validate_completed_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM fintrace.validate_completed_transaction(OLD.transaction_id, OLD.tenant_id);
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.transaction_id IS DISTINCT FROM NEW.transaction_id THEN
        PERFORM fintrace.validate_completed_transaction(OLD.transaction_id, OLD.tenant_id);
    END IF;

    PERFORM fintrace.validate_completed_transaction(NEW.transaction_id, NEW.tenant_id);
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transactions_completed_ct
AFTER INSERT OR UPDATE OF status ON fintrace.ledger_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.trg_validate_completed_transaction();

CREATE CONSTRAINT TRIGGER ledger_entries_balance_ct
AFTER INSERT OR UPDATE OR DELETE ON fintrace.ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.trg_validate_completed_transaction();

CREATE TRIGGER ledger_entries_validate_before
BEFORE INSERT OR UPDATE ON fintrace.ledger_entries
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_ledger_entry();

CREATE TRIGGER ledger_entries_block_terminal_delete
BEFORE DELETE ON fintrace.ledger_entries
FOR EACH ROW
EXECUTE FUNCTION fintrace.block_ledger_entry_delete();

CREATE TRIGGER ledger_transactions_reversal_validate
BEFORE INSERT OR UPDATE OF reverses_transaction_id ON fintrace.ledger_transactions
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_reversal();

CREATE TRIGGER ledger_transactions_terminal_immutable
BEFORE UPDATE ON fintrace.ledger_transactions
FOR EACH ROW
EXECUTE FUNCTION fintrace.block_terminal_ledger_update();

-- -----------------------------------------------------------------------------
-- Category / recurring / instrument / debt validation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.validate_active_references()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.category_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM fintrace.categories 
            WHERE id = NEW.category_id AND (NOT is_active OR archived_at IS NOT NULL)
        ) THEN
            RAISE EXCEPTION 'Cannot associate financial record with an archived or inactive category' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER income_category_active_validate
BEFORE INSERT OR UPDATE OF category_id ON fintrace.income_records
FOR EACH ROW EXECUTE FUNCTION fintrace.validate_active_references();

CREATE TRIGGER expense_category_active_validate
BEFORE INSERT OR UPDATE OF category_id ON fintrace.expense_records
FOR EACH ROW EXECUTE FUNCTION fintrace.validate_active_references();

CREATE OR REPLACE FUNCTION fintrace.enforce_category_type()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_type TEXT;
    p_expected TEXT := TG_ARGV[0];
BEGIN
    IF NEW.category_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c.type INTO v_type
      FROM fintrace.categories c
     WHERE c.tenant_id = NEW.tenant_id
       AND c.id = NEW.category_id;

    IF p_expected = 'INCOME' AND v_type <> 'INCOME' THEN
        RAISE EXCEPTION 'Income record requires an INCOME category'
            USING ERRCODE = '23514';
    ELSIF p_expected = 'EXPENSE' AND v_type <> 'EXPENSE' THEN
        RAISE EXCEPTION 'Expense record requires an EXPENSE category'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER income_category_type_validate
BEFORE INSERT OR UPDATE OF category_id ON fintrace.income_records
FOR EACH ROW
EXECUTE FUNCTION fintrace.enforce_category_type('INCOME');

CREATE TRIGGER expense_category_type_validate
BEFORE INSERT OR UPDATE OF category_id ON fintrace.expense_records
FOR EACH ROW
EXECUTE FUNCTION fintrace.enforce_category_type('EXPENSE');

CREATE OR REPLACE FUNCTION fintrace.validate_recurring_definition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_category_type TEXT;
BEGIN
    IF NEW.transaction_type = 'INCOME' THEN
        IF NEW.category_id IS NOT NULL THEN
            SELECT type INTO v_category_type FROM fintrace.categories
             WHERE tenant_id = NEW.tenant_id AND id = NEW.category_id;
            IF v_category_type <> 'INCOME' THEN
                RAISE EXCEPTION 'Recurring INCOME requires an INCOME category' USING ERRCODE = '23514';
            END IF;
        END IF;
    ELSIF NEW.transaction_type = 'EXPENSE' THEN
        IF NEW.category_id IS NOT NULL THEN
            SELECT type INTO v_category_type FROM fintrace.categories
             WHERE tenant_id = NEW.tenant_id AND id = NEW.category_id;
            IF v_category_type <> 'EXPENSE' THEN
                RAISE EXCEPTION 'Recurring EXPENSE requires an EXPENSE category' USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER recurring_definition_validate
BEFORE INSERT OR UPDATE ON fintrace.recurring_transactions
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_recurring_definition();

CREATE OR REPLACE FUNCTION fintrace.validate_goal_contribution_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_currency UUID;
BEGIN
    SELECT currency_id INTO v_currency
      FROM fintrace.goals
     WHERE tenant_id = NEW.tenant_id AND id = NEW.goal_id;
    IF v_currency <> NEW.currency_id THEN
        RAISE EXCEPTION 'Goal contribution currency must match goal currency' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER goal_contribution_currency_validate
BEFORE INSERT OR UPDATE OF goal_id, currency_id, tenant_id ON fintrace.goal_contributions
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_goal_contribution_currency();

CREATE OR REPLACE FUNCTION fintrace.validate_asset_valuation_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_currency UUID;
BEGIN
    SELECT currency_id INTO v_currency
      FROM fintrace.assets
     WHERE tenant_id = NEW.tenant_id AND id = NEW.asset_id;
    IF v_currency <> NEW.currency_id THEN
        RAISE EXCEPTION 'Asset valuation currency must match asset currency' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_valuation_currency_validate
BEFORE INSERT OR UPDATE OF asset_id, currency_id, tenant_id ON fintrace.asset_valuations
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_asset_valuation_currency();

CREATE OR REPLACE FUNCTION fintrace.validate_subscription_accounts_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_currency UUID;
BEGIN
    IF NEW.account_id IS NOT NULL THEN
        SELECT currency_id INTO v_currency
          FROM fintrace.accounts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id;
        IF v_currency <> NEW.currency_id THEN
            RAISE EXCEPTION 'Subscription account currency must match subscription currency' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER subscription_currency_validate
BEFORE INSERT OR UPDATE ON fintrace.subscriptions
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_subscription_accounts_currency();

CREATE OR REPLACE FUNCTION fintrace.validate_recurring_accounts_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_source_currency UUID;
    v_destination_currency UUID;
BEGIN
    IF NEW.source_account_id IS NOT NULL THEN
        SELECT currency_id INTO v_source_currency
          FROM fintrace.accounts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.source_account_id;
        IF v_source_currency <> NEW.currency_id THEN
            RAISE EXCEPTION 'Recurring source account currency must match recurring currency' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.destination_account_id IS NOT NULL THEN
        SELECT currency_id INTO v_destination_currency
          FROM fintrace.accounts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.destination_account_id;
        IF v_destination_currency <> NEW.currency_id THEN
            RAISE EXCEPTION 'Recurring destination account currency must match recurring currency' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.transaction_type = 'TRANSFER' AND v_source_currency <> v_destination_currency THEN
        RAISE EXCEPTION 'Recurring transfers currently require both accounts to use the same currency' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER recurring_accounts_currency_validate
BEFORE INSERT OR UPDATE ON fintrace.recurring_transactions
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_recurring_accounts_currency();

CREATE OR REPLACE FUNCTION fintrace.protect_instrument_tenant_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Investment instrument tenant ownership cannot be changed' USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER investment_instrument_tenant_immutable
BEFORE UPDATE OF tenant_id ON fintrace.investment_instruments
FOR EACH ROW
EXECUTE FUNCTION fintrace.protect_instrument_tenant_identity();

CREATE OR REPLACE FUNCTION fintrace.validate_instrument_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_instrument_tenant UUID;
BEGIN
    SELECT tenant_id INTO v_instrument_tenant
      FROM fintrace.investment_instruments
     WHERE id = NEW.instrument_id;

    IF v_instrument_tenant IS NULL THEN
        RETURN NEW;
    END IF;

    IF v_instrument_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION 'Investment instrument % belongs to a different tenant', NEW.instrument_id
            USING ERRCODE = '23503';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER investment_position_instrument_validate
BEFORE INSERT OR UPDATE OF instrument_id, tenant_id ON fintrace.investment_positions
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_instrument_tenant();

CREATE TRIGGER investment_trade_instrument_validate
BEFORE INSERT OR UPDATE OF instrument_id, tenant_id ON fintrace.investment_trades
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_instrument_tenant();

CREATE TRIGGER investment_dividend_instrument_validate
BEFORE INSERT OR UPDATE OF instrument_id, tenant_id ON fintrace.investment_dividends
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_instrument_tenant();

CREATE OR REPLACE FUNCTION fintrace.validate_income_expense_ledger_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
    v_is_income BOOLEAN;
    v_match BOOLEAN;
BEGIN
    SELECT status INTO v_status
      FROM fintrace.ledger_transactions
     WHERE tenant_id = NEW.tenant_id AND id = NEW.ledger_transaction_id;

    IF v_status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'Income/expense records require a COMPLETED ledger transaction' USING ERRCODE = '23514';
    END IF;

    v_is_income := TG_TABLE_NAME = 'income_records';
    SELECT EXISTS (
        SELECT 1
          FROM fintrace.ledger_entries le
         WHERE le.tenant_id = NEW.tenant_id
           AND le.transaction_id = NEW.ledger_transaction_id
           AND le.currency_id = NEW.currency_id
           AND le.amount = NEW.amount
           AND ((v_is_income AND le.credit_amount = NEW.amount)
                OR (NOT v_is_income AND le.debit_amount = NEW.amount))
    ) INTO v_match;

    IF NOT v_match THEN
        RAISE EXCEPTION 'Income/expense amount and currency must be represented by a matching ledger entry' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER income_ledger_link_ct
AFTER INSERT OR UPDATE ON fintrace.income_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_income_expense_ledger_link();

CREATE CONSTRAINT TRIGGER expense_ledger_link_ct
AFTER INSERT OR UPDATE ON fintrace.expense_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_income_expense_ledger_link();

CREATE OR REPLACE FUNCTION fintrace.validate_debt_repayment_ledger_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_currency UUID;
    v_type TEXT;
    v_match BOOLEAN;
BEGIN
    SELECT currency_id, type INTO v_currency, v_type
      FROM fintrace.debts
     WHERE tenant_id = NEW.tenant_id AND id = NEW.debt_id;

    IF NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_transactions
         WHERE tenant_id = NEW.tenant_id
           AND id = NEW.ledger_transaction_id
           AND status = 'COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Debt repayments require a COMPLETED ledger transaction' USING ERRCODE = '23514';
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM fintrace.ledger_entries le
         WHERE le.tenant_id = NEW.tenant_id
           AND le.transaction_id = NEW.ledger_transaction_id
           AND le.currency_id = v_currency
           AND le.amount = NEW.total_amount
           AND (
               (v_type = 'PAYABLE' AND le.debit_amount = NEW.total_amount)
               OR
               (v_type = 'RECEIVABLE' AND le.credit_amount = NEW.total_amount)
           )
    ) INTO v_match;

    IF NOT v_match THEN
        RAISE EXCEPTION 'Debt repayment must have a matching principal/interest ledger entry' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER debt_repayment_ledger_link_ct
AFTER INSERT OR UPDATE ON fintrace.debt_repayments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_debt_repayment_ledger_link();

CREATE OR REPLACE FUNCTION fintrace.validate_goal_contribution_ledger_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_match BOOLEAN;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_transactions
         WHERE tenant_id = NEW.tenant_id
           AND id = NEW.ledger_transaction_id
           AND status = 'COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Goal contributions require a COMPLETED ledger transaction' USING ERRCODE = '23514';
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM fintrace.ledger_entries le
         WHERE le.tenant_id = NEW.tenant_id
           AND le.transaction_id = NEW.ledger_transaction_id
           AND le.currency_id = NEW.currency_id
           AND le.amount = NEW.amount
    ) INTO v_match;

    IF NOT v_match THEN
        RAISE EXCEPTION 'Goal contribution must have a matching ledger entry' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER goal_contribution_ledger_link_ct
AFTER INSERT OR UPDATE ON fintrace.goal_contributions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_goal_contribution_ledger_link();

CREATE OR REPLACE FUNCTION fintrace.validate_transaction_metadata(
    p_transaction_id UUID,
    p_tenant_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
    v_match BOOLEAN;
    v_currency UUID;
    v_type TEXT;
    v_amount NUMERIC(19,4);
BEGIN
    SELECT status INTO v_status
      FROM fintrace.ledger_transactions
     WHERE tenant_id = p_tenant_id AND id = p_transaction_id;

    IF v_status IS NULL THEN
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM fintrace.income_records
                WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id) THEN
        IF v_status <> 'COMPLETED' THEN
            RAISE EXCEPTION 'Income record requires a COMPLETED ledger transaction' USING ERRCODE = '23514';
        END IF;
        FOR v_amount, v_currency IN
            SELECT amount, currency_id FROM fintrace.income_records
             WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id
        LOOP
            SELECT EXISTS (
                SELECT 1 FROM fintrace.ledger_entries
                 WHERE tenant_id = p_tenant_id AND transaction_id = p_transaction_id
                   AND currency_id = v_currency AND amount = v_amount
                   AND credit_amount = v_amount
            ) INTO v_match;
            IF NOT v_match THEN
                RAISE EXCEPTION 'Income record is not represented by its ledger transaction' USING ERRCODE = '23514', DETAIL = 'Ledger transaction: ' || p_transaction_id;
            END IF;
        END LOOP;
    END IF;

    IF EXISTS (SELECT 1 FROM fintrace.expense_records
                WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id) THEN
        IF v_status <> 'COMPLETED' THEN
            RAISE EXCEPTION 'Expense record requires a COMPLETED ledger transaction' USING ERRCODE = '23514';
        END IF;
        FOR v_amount, v_currency IN
            SELECT amount, currency_id FROM fintrace.expense_records
             WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id
        LOOP
            SELECT EXISTS (
                SELECT 1 FROM fintrace.ledger_entries
                 WHERE tenant_id = p_tenant_id AND transaction_id = p_transaction_id
                   AND currency_id = v_currency AND amount = v_amount
                   AND debit_amount = v_amount
            ) INTO v_match;
            IF NOT v_match THEN
                RAISE EXCEPTION 'Expense record is not represented by its ledger transaction' USING ERRCODE = '23514';
            END IF;
        END LOOP;
    END IF;

    FOR v_currency, v_type, v_amount IN
        SELECT d.currency_id, d.type, r.total_amount
          FROM fintrace.debt_repayments r
          JOIN fintrace.debts d ON d.tenant_id = r.tenant_id AND d.id = r.debt_id
         WHERE r.tenant_id = p_tenant_id AND r.ledger_transaction_id = p_transaction_id
    LOOP
        IF v_status <> 'COMPLETED' THEN
            RAISE EXCEPTION 'Debt repayment requires a COMPLETED ledger transaction' USING ERRCODE = '23514';
        END IF;
        SELECT EXISTS (
            SELECT 1 FROM fintrace.ledger_entries
             WHERE tenant_id = p_tenant_id AND transaction_id = p_transaction_id
               AND currency_id = v_currency AND amount = v_amount
               AND ((v_type = 'PAYABLE' AND debit_amount = v_amount)
                    OR (v_type = 'RECEIVABLE' AND credit_amount = v_amount))
        ) INTO v_match;
        IF NOT v_match THEN
            RAISE EXCEPTION 'Debt repayment is not represented by its ledger transaction' USING ERRCODE = '23514';
        END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM fintrace.goal_contributions
                WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id) THEN
        IF v_status <> 'COMPLETED' THEN
            RAISE EXCEPTION 'Goal contribution requires a COMPLETED ledger transaction' USING ERRCODE = '23514';
        END IF;
        FOR v_amount, v_currency IN
            SELECT amount, currency_id FROM fintrace.goal_contributions
             WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id
        LOOP
            IF NOT EXISTS (
                SELECT 1 FROM fintrace.ledger_entries
                 WHERE tenant_id = p_tenant_id AND transaction_id = p_transaction_id
                   AND currency_id = v_currency AND amount = v_amount
            ) THEN
                RAISE EXCEPTION 'Goal contribution is not represented by its ledger transaction' USING ERRCODE = '23514';
            END IF;
        END LOOP;
    END IF;

    IF EXISTS (SELECT 1 FROM fintrace.investment_trades
                WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id)
       OR EXISTS (SELECT 1 FROM fintrace.investment_dividends
                WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id) THEN
        IF v_status <> 'COMPLETED' THEN
            RAISE EXCEPTION 'Investment financial events require a COMPLETED ledger transaction' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM fintrace.recurring_transaction_occurrences
                WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id
                  AND status = 'COMPLETED')
       AND v_status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'Completed recurring occurrence requires a COMPLETED ledger transaction' USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.trg_validate_transaction_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM fintrace.validate_transaction_metadata(OLD.transaction_id, OLD.tenant_id);
        RETURN OLD;
    END IF;

    IF TG_TABLE_NAME = 'ledger_transactions' THEN
        PERFORM fintrace.validate_transaction_metadata(NEW.id, NEW.tenant_id);
    ELSE
        IF TG_OP = 'UPDATE' AND OLD.transaction_id IS DISTINCT FROM NEW.transaction_id THEN
            PERFORM fintrace.validate_transaction_metadata(OLD.transaction_id, OLD.tenant_id);
        END IF;
        PERFORM fintrace.validate_transaction_metadata(NEW.transaction_id, NEW.tenant_id);
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER transaction_metadata_ledger_ct
AFTER INSERT OR UPDATE OF status ON fintrace.ledger_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.trg_validate_transaction_metadata();

CREATE CONSTRAINT TRIGGER transaction_metadata_entry_ct
AFTER INSERT OR UPDATE OR DELETE ON fintrace.ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.trg_validate_transaction_metadata();

CREATE CONSTRAINT TRIGGER investment_trade_ledger_link_ct
AFTER INSERT OR UPDATE ON fintrace.investment_trades
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.trg_validate_transaction_metadata();

CREATE CONSTRAINT TRIGGER investment_dividend_ledger_link_ct
AFTER INSERT OR UPDATE ON fintrace.investment_dividends
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.trg_validate_transaction_metadata();

CREATE OR REPLACE FUNCTION fintrace.validate_debt_status(p_debt_id UUID, p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
    v_principal NUMERIC(19,4);
    v_repaid_principal NUMERIC(30,4);
    v_outstanding NUMERIC(30,4);
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
      FROM fintrace.debt_repayments
     WHERE tenant_id = p_tenant_id AND debt_id = p_debt_id;

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

CREATE OR REPLACE FUNCTION fintrace.trg_validate_debt_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM fintrace.validate_debt_status(OLD.debt_id, OLD.tenant_id);
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.debt_id IS DISTINCT FROM NEW.debt_id THEN
        PERFORM fintrace.validate_debt_status(OLD.debt_id, OLD.tenant_id);
    END IF;

    PERFORM fintrace.validate_debt_status(NEW.debt_id, NEW.tenant_id);
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER debt_status_repayment_ct
AFTER INSERT OR UPDATE OR DELETE ON fintrace.debt_repayments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.trg_validate_debt_status();

CREATE CONSTRAINT TRIGGER debt_status_change_ct
AFTER INSERT OR UPDATE OF status ON fintrace.debts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.trg_validate_debt_status();

-- -----------------------------------------------------------------------------
-- Investment position maintenance: trades are immutable source events
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.block_investment_trade_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Investment trades are immutable; create a compensating trade or ledger correction'
        USING ERRCODE = '25006';
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.apply_investment_trade_to_position()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_quantity NUMERIC(24,8) := 0;
    v_average_cost NUMERIC(19,6) := 0;
BEGIN
    PERFORM 1 FROM fintrace.investment_portfolios
     WHERE tenant_id = NEW.tenant_id AND id = NEW.portfolio_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Investment portfolio not found for tenant' USING ERRCODE = '23503';
    END IF;

    SELECT quantity, average_cost
      INTO v_quantity, v_average_cost
      FROM fintrace.investment_positions
     WHERE tenant_id = NEW.tenant_id
       AND portfolio_id = NEW.portfolio_id
       AND instrument_id = NEW.instrument_id
     FOR UPDATE;

    IF NEW.trade_type = 'BUY' THEN
        IF v_quantity = 0 THEN
            v_average_cost := round(((NEW.quantity * NEW.price) + NEW.fees) / NEW.quantity, 6);
        ELSE
            v_average_cost := round((v_quantity * v_average_cost + NEW.quantity * NEW.price + NEW.fees)
                                    / (v_quantity + NEW.quantity), 6);
        END IF;
        v_quantity := v_quantity + NEW.quantity;
        NEW.realized_pnl := 0;
    ELSE
        IF v_quantity < NEW.quantity THEN
            RAISE EXCEPTION 'Cannot sell % units when only % are available', NEW.quantity, v_quantity
                USING ERRCODE = '23514';
        END IF;
        NEW.realized_pnl := round((NEW.price - v_average_cost) * NEW.quantity - NEW.fees, 4);
        v_quantity := v_quantity - NEW.quantity;
        IF v_quantity = 0 THEN
            v_average_cost := 0;
        END IF;
    END IF;

    INSERT INTO fintrace.investment_positions (
        tenant_id, portfolio_id, instrument_id, quantity, average_cost
    ) VALUES (
        NEW.tenant_id, NEW.portfolio_id, NEW.instrument_id, v_quantity, v_average_cost
    )
    ON CONFLICT (tenant_id, portfolio_id, instrument_id)
    DO UPDATE SET
        quantity = EXCLUDED.quantity,
        average_cost = EXCLUDED.average_cost,
        updated_at = clock_timestamp();

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.guard_investment_position_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'Investment positions are derived from immutable trades'
            USING ERRCODE = '25006';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER investment_trade_apply_position
BEFORE INSERT ON fintrace.investment_trades
FOR EACH ROW
EXECUTE FUNCTION fintrace.apply_investment_trade_to_position();

CREATE TRIGGER investment_trade_no_update
BEFORE UPDATE OR DELETE ON fintrace.investment_trades
FOR EACH ROW
EXECUTE FUNCTION fintrace.block_investment_trade_mutation();

CREATE TRIGGER investment_position_guard
BEFORE INSERT OR UPDATE OR DELETE ON fintrace.investment_positions
FOR EACH ROW
EXECUTE FUNCTION fintrace.guard_investment_position_write();

-- -----------------------------------------------------------------------------
-- Audit trail
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_tenant UUID;
    v_entity_id UUID;
    v_before JSONB;
    v_after JSONB;
    v_actor UUID := fintrace.current_user_id();
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Audit trail requires an active user session context (fintrace.current_user_id is null)' USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'DELETE' THEN
        v_before := to_jsonb(OLD);
        v_after := NULL;
    ELSIF TG_OP = 'UPDATE' THEN
        v_before := to_jsonb(OLD);
        v_after := to_jsonb(NEW);
    ELSE
        v_before := NULL;
        v_after := to_jsonb(NEW);
    END IF;

    IF TG_TABLE_NAME = 'tenants' THEN
        v_tenant := COALESCE((v_after->>'id')::UUID, (v_before->>'id')::UUID);
    ELSIF TG_TABLE_NAME IN ('rbac_membership_roles','rbac_user_permission_overrides') THEN
        SELECT tenant_id INTO v_tenant
          FROM fintrace.tenant_memberships
         WHERE id = COALESCE((v_after->>'membership_id')::UUID, (v_before->>'membership_id')::UUID);
    ELSIF TG_TABLE_NAME = 'rbac_role_permissions' THEN
        SELECT tenant_id INTO v_tenant
          FROM fintrace.rbac_roles
         WHERE id = COALESCE((v_after->>'role_id')::UUID, (v_before->>'role_id')::UUID);
    ELSE
        v_tenant := COALESCE((v_after->>'tenant_id')::UUID, (v_before->>'tenant_id')::UUID);
    END IF;

    v_entity_id := COALESCE((v_after->>'id')::UUID, (v_before->>'id')::UUID);

    IF v_tenant IS NOT NULL THEN
        INSERT INTO fintrace.audit_events (
            tenant_id, actor_user_id, action, entity_type, entity_id,
            request_id, before_data, after_data, metadata, ip_address, user_agent
        ) VALUES (
            v_tenant,
            v_actor,
            lower(TG_OP),
            TG_TABLE_NAME,
            v_entity_id,
            NULLIF(current_setting('fintrace.request_id', true), '')::UUID,
            v_before,
            v_after,
            jsonb_build_object('schema','fintrace'),
            NULLIF(current_setting('fintrace.client_ip', true), '')::INET,
            COALESCE(current_setting('fintrace.user_agent', true), '')
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.audit_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are append-only'
        USING ERRCODE = '25006';
END;
$$;

CREATE TRIGGER audit_events_immutable_update
BEFORE UPDATE ON fintrace.audit_events
FOR EACH ROW
EXECUTE FUNCTION fintrace.audit_immutable();

CREATE TRIGGER audit_events_immutable_delete
BEFORE DELETE ON fintrace.audit_events
FOR EACH ROW
EXECUTE FUNCTION fintrace.audit_immutable();

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'currencies','users','tenants','rbac_roles','tenant_memberships',
        'rbac_user_permission_overrides','idempotency_operations','categories','tags',
        'contacts','accounts','ledger_transactions','ledger_entries',
        'income_records','expense_records','debts','debt_repayments',
        'investment_portfolios','investment_instruments','investment_positions',
        'investment_trades','investment_dividends','assets','goals','subscriptions',
        'recurring_transactions','recurring_transaction_occurrences'
    ] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I_updated_at ON fintrace.%I',
            t, t
        );
        EXECUTE format(
            'CREATE TRIGGER %I_updated_at BEFORE UPDATE ON fintrace.%I FOR EACH ROW EXECUTE FUNCTION fintrace.set_updated_at()',
            t, t
        );
    END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- Audit selected business/security tables
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'tenants','tenant_memberships','rbac_roles','rbac_membership_roles','rbac_role_permissions','rbac_user_permission_overrides',
        'accounts','categories','tags','contacts','ledger_transactions','ledger_entries',
        'income_records','expense_records','debts','debt_repayments',
        'investment_portfolios','investment_instruments','investment_dividends',
        'assets','asset_valuations','goals','goal_contributions',
        'subscriptions','recurring_transactions','recurring_transaction_occurrences'
    ] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS %I_audit ON fintrace.%I',
            t, t
        );
        EXECUTE format(
            'CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON fintrace.%I FOR EACH ROW EXECUTE FUNCTION fintrace.audit_row_change()',
            t, t
        );
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.validate_tenant_base_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM fintrace.currencies WHERE id = NEW.base_currency_id AND is_active) THEN
        RAISE EXCEPTION 'Tenant base currency must be active' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_base_currency_validate
BEFORE INSERT OR UPDATE OF base_currency_id ON fintrace.tenants
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_tenant_base_currency();

-- -----------------------------------------------------------------------------
-- Ownership / lifecycle protection
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.block_tenant_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Tenant deletion is disabled; close/suspend the tenant instead'
        USING ERRCODE = '25006';
END;
$$;

CREATE TRIGGER tenants_no_delete
BEFORE DELETE ON fintrace.tenants
FOR EACH ROW
EXECUTE FUNCTION fintrace.block_tenant_delete();

CREATE OR REPLACE FUNCTION fintrace.validate_tenant_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
BEGIN
    PERFORM fintrace.validate_tenant_owner_for_id(NEW.id);
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER tenants_owner_membership_ct
AFTER INSERT OR UPDATE OF owner_id ON fintrace.tenants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_tenant_owner();

CREATE OR REPLACE FUNCTION fintrace.trg_validate_owner_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_old_tenant UUID;
    v_new_tenant UUID;
BEGIN
    IF TG_TABLE_NAME = 'tenant_memberships' THEN
        v_old_tenant := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.tenant_id END;
        v_new_tenant := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.tenant_id END;
    ELSE
        IF TG_OP = 'DELETE' THEN
            SELECT tenant_id INTO v_old_tenant FROM fintrace.tenant_memberships WHERE id = OLD.membership_id;
        ELSE
            SELECT tenant_id INTO v_new_tenant FROM fintrace.tenant_memberships WHERE id = NEW.membership_id;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.membership_id IS DISTINCT FROM NEW.membership_id THEN
            SELECT tenant_id INTO v_old_tenant FROM fintrace.tenant_memberships WHERE id = OLD.membership_id;
        ELSIF TG_OP = 'DELETE' THEN
            NULL;
        ELSE
            v_old_tenant := v_new_tenant;
        END IF;
    END IF;

    IF v_old_tenant IS NOT NULL THEN
        PERFORM fintrace.validate_tenant_owner_for_id(v_old_tenant);
    END IF;
    IF v_new_tenant IS NOT NULL THEN
        PERFORM fintrace.validate_tenant_owner_for_id(v_new_tenant);
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.validate_tenant_owner_for_id(p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_owner_id UUID;
BEGIN
    SELECT owner_id INTO v_owner_id FROM fintrace.tenants WHERE id = p_tenant_id;
    IF v_owner_id IS NULL THEN
        RETURN;
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM fintrace.tenant_memberships m
          JOIN fintrace.rbac_membership_roles mr ON mr.membership_id = m.id
          JOIN fintrace.rbac_roles r ON r.id = mr.role_id
         WHERE m.tenant_id = p_tenant_id
           AND m.user_id = v_owner_id
           AND m.status = 'ACTIVE'
           AND r.tenant_id IS NULL
           AND r.code = 'ADMIN'
           AND r.is_system
           AND r.is_active
    ) THEN
        RAISE EXCEPTION 'Tenant owner must be an active member with system ADMIN role' USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.validate_membership_role_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_membership_tenant UUID;
    v_role_tenant UUID;
BEGIN
    SELECT tenant_id INTO v_membership_tenant
      FROM fintrace.tenant_memberships WHERE id = NEW.membership_id;
    SELECT tenant_id INTO v_role_tenant
      FROM fintrace.rbac_roles WHERE id = NEW.role_id;

    IF v_membership_tenant IS NULL THEN
        RAISE EXCEPTION 'Membership does not exist' USING ERRCODE = '23503';
    END IF;

    IF v_role_tenant IS NOT NULL AND v_role_tenant <> v_membership_tenant THEN
        RAISE EXCEPTION 'Tenant-scoped role cannot be assigned across tenants' USING ERRCODE = '23503';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER rbac_membership_roles_tenant_validate
BEFORE INSERT OR UPDATE ON fintrace.rbac_membership_roles
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_membership_role_tenant();

CREATE OR REPLACE FUNCTION fintrace.validate_user_override_permission_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_membership_tenant UUID;
BEGIN
    SELECT tenant_id INTO v_membership_tenant
      FROM fintrace.tenant_memberships
     WHERE id = NEW.membership_id;
    IF v_membership_tenant IS NULL THEN
        RAISE EXCEPTION 'Membership does not exist' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER rbac_user_override_tenant_validate
BEFORE INSERT OR UPDATE ON fintrace.rbac_user_permission_overrides
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_user_override_permission_tenant();

CREATE CONSTRAINT TRIGGER membership_owner_consistency_ct
AFTER INSERT OR UPDATE OR DELETE ON fintrace.tenant_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.trg_validate_owner_change();

CREATE CONSTRAINT TRIGGER membership_role_owner_consistency_ct
AFTER INSERT OR UPDATE OR DELETE ON fintrace.rbac_membership_roles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.trg_validate_owner_change();

CREATE OR REPLACE FUNCTION fintrace.protect_system_role()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.code IS DISTINCT FROM OLD.code
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
        RAISE EXCEPTION 'RBAC role code and tenant ownership are immutable' USING ERRCODE = '25006';
    END IF;

    IF OLD.is_system AND (
        NEW.is_system IS DISTINCT FROM OLD.is_system
        OR NEW.is_active IS DISTINCT FROM OLD.is_active
    ) THEN
        RAISE EXCEPTION 'System RBAC roles cannot be disabled or converted' USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.block_system_role_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.is_system THEN
        RAISE EXCEPTION 'System RBAC roles cannot be deleted' USING ERRCODE = '25006';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER rbac_roles_system_immutable
BEFORE UPDATE ON fintrace.rbac_roles
FOR EACH ROW
EXECUTE FUNCTION fintrace.protect_system_role();

CREATE TRIGGER rbac_roles_system_no_delete
BEFORE DELETE ON fintrace.rbac_roles
FOR EACH ROW
EXECUTE FUNCTION fintrace.block_system_role_delete();

CREATE OR REPLACE FUNCTION fintrace.block_business_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Business records are not deleted; use the lifecycle/archive fields' USING ERRCODE = '25006';
END;
$$;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'users','tenant_memberships','categories','tags','contacts','accounts','ledger_transactions',
        'income_records','expense_records','debts','debt_repayments',
        'investment_portfolios','investment_instruments','investment_positions',
        'investment_trades','investment_dividends','assets','asset_valuations',
        'goals','goal_contributions','subscriptions','recurring_transactions',
        'recurring_transaction_occurrences'
    ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I_no_delete ON fintrace.%I', t, t);
        EXECUTE format('CREATE TRIGGER %I_no_delete BEFORE DELETE ON fintrace.%I FOR EACH ROW EXECUTE FUNCTION fintrace.block_business_delete()', t, t);
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.protect_tenant_base_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.base_currency_id IS DISTINCT FROM NEW.base_currency_id
       AND EXISTS (SELECT 1 FROM fintrace.ledger_transactions WHERE tenant_id = OLD.id) THEN
        RAISE EXCEPTION 'Tenant base currency cannot change after financial transactions exist' USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_base_currency_immutable_after_ledger
BEFORE UPDATE OF base_currency_id ON fintrace.tenants
FOR EACH ROW
EXECUTE FUNCTION fintrace.protect_tenant_base_currency();

CREATE OR REPLACE FUNCTION fintrace.protect_account_financial_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF (OLD.currency_id IS DISTINCT FROM NEW.currency_id
        OR OLD.type IS DISTINCT FROM NEW.type
        OR OLD.normal_balance IS DISTINCT FROM NEW.normal_balance)
       AND EXISTS (SELECT 1 FROM fintrace.ledger_entries WHERE tenant_id = OLD.tenant_id AND account_id = OLD.id) THEN
        RAISE EXCEPTION 'Account currency/type/normal balance cannot change after ledger activity exists' USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_financial_identity_immutable
BEFORE UPDATE OF currency_id, type, normal_balance ON fintrace.accounts
FOR EACH ROW
EXECUTE FUNCTION fintrace.protect_account_financial_identity();

CREATE OR REPLACE FUNCTION fintrace.protect_category_type_after_use()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.type IS DISTINCT FROM NEW.type AND (
        EXISTS (SELECT 1 FROM fintrace.income_records WHERE tenant_id = OLD.tenant_id AND category_id = OLD.id)
        OR EXISTS (SELECT 1 FROM fintrace.expense_records WHERE tenant_id = OLD.tenant_id AND category_id = OLD.id)
        OR EXISTS (SELECT 1 FROM fintrace.recurring_transactions WHERE tenant_id = OLD.tenant_id AND category_id = OLD.id)
    ) THEN
        RAISE EXCEPTION 'Category type cannot change after it has been used' USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER categories_type_immutable_after_use
BEFORE UPDATE OF type ON fintrace.categories
FOR EACH ROW
EXECUTE FUNCTION fintrace.protect_category_type_after_use();

CREATE OR REPLACE FUNCTION fintrace.protect_debt_identity_after_repayment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF (OLD.type IS DISTINCT FROM NEW.type
        OR OLD.contact_id IS DISTINCT FROM NEW.contact_id
        OR OLD.principal_amount IS DISTINCT FROM NEW.principal_amount
        OR OLD.currency_id IS DISTINCT FROM NEW.currency_id
        OR OLD.start_date IS DISTINCT FROM NEW.start_date)
       AND EXISTS (SELECT 1 FROM fintrace.debt_repayments WHERE tenant_id = OLD.tenant_id AND debt_id = OLD.id) THEN
        RAISE EXCEPTION 'Debt identity/principal/currency cannot change after a repayment exists' USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER debts_identity_immutable_after_repayment
BEFORE UPDATE OF type, contact_id, principal_amount, currency_id, start_date ON fintrace.debts
FOR EACH ROW
EXECUTE FUNCTION fintrace.protect_debt_identity_after_repayment();

CREATE OR REPLACE FUNCTION fintrace.block_history_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Financial history rows are immutable; create a compensating financial event instead' USING ERRCODE = '25006';
END;
$$;

CREATE TRIGGER debt_repayments_immutable_update
BEFORE UPDATE ON fintrace.debt_repayments
FOR EACH ROW EXECUTE FUNCTION fintrace.block_history_update();
CREATE TRIGGER goal_contributions_immutable_update
BEFORE UPDATE ON fintrace.goal_contributions
FOR EACH ROW EXECUTE FUNCTION fintrace.block_history_update();
CREATE TRIGGER asset_valuations_immutable_update
BEFORE UPDATE ON fintrace.asset_valuations
FOR EACH ROW EXECUTE FUNCTION fintrace.block_history_update();
CREATE TRIGGER investment_dividends_immutable_update
BEFORE UPDATE ON fintrace.investment_dividends
FOR EACH ROW EXECUTE FUNCTION fintrace.block_history_update();

-- -----------------------------------------------------------------------------
-- Tenant provisioning function
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.provision_tenant(
    p_user_id UUID,
    p_slug VARCHAR,
    p_name VARCHAR,
    p_base_currency_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_tenant_id UUID;
    v_admin_role_id UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM fintrace.users WHERE id = p_user_id AND status = 'ACTIVE') THEN
        RAISE EXCEPTION 'Active user % is required to provision a tenant', p_user_id USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM fintrace.currencies WHERE id = p_base_currency_id AND is_active) THEN
        RAISE EXCEPTION 'Active base currency is required' USING ERRCODE = '23514';
    END IF;

    SELECT id INTO v_admin_role_id
      FROM fintrace.rbac_roles
     WHERE tenant_id IS NULL
       AND code = 'ADMIN'
       AND is_active
       AND is_system
     LIMIT 1;

    IF v_admin_role_id IS NULL THEN
        RAISE EXCEPTION 'System ADMIN role is missing';
    END IF;

    INSERT INTO fintrace.tenants (slug, name, owner_id, base_currency_id)
    VALUES (p_slug, p_name, p_user_id, p_base_currency_id)
    RETURNING id INTO v_tenant_id;

    INSERT INTO fintrace.tenant_memberships (tenant_id, user_id, status, joined_at)
    VALUES (v_tenant_id, p_user_id, 'ACTIVE', clock_timestamp());

    INSERT INTO fintrace.rbac_membership_roles (membership_id, role_id)
    VALUES (
        (SELECT id FROM fintrace.tenant_memberships
          WHERE tenant_id = v_tenant_id AND user_id = p_user_id),
        v_admin_role_id
    );

    RETURN v_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION fintrace.provision_tenant(UUID, VARCHAR, VARCHAR, UUID) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Tenant RLS (RBAC Integrated)
-- -----------------------------------------------------------------------------

ALTER TABLE fintrace.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.idempotency_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.ledger_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.income_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.income_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.expense_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.expense_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.debts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.debt_repayments ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.investment_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.investment_instruments ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.investment_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.investment_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.investment_dividends ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.asset_valuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.goal_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.recurring_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.recurring_transaction_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.rbac_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.rbac_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.rbac_membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.rbac_user_permission_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_memberships_isolation ON fintrace.tenant_memberships
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('memberships.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id());

CREATE POLICY idempotency_isolation ON fintrace.idempotency_operations
    USING (tenant_id = fintrace.current_tenant_id())
    WITH CHECK (tenant_id = fintrace.current_tenant_id());

CREATE POLICY audit_isolation ON fintrace.audit_events
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('audit.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id());

CREATE POLICY categories_select ON fintrace.categories FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('categories.view'));
CREATE POLICY categories_insert ON fintrace.categories FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('categories.create'));
CREATE POLICY categories_update ON fintrace.categories FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('categories.update'));

CREATE POLICY tags_select ON fintrace.tags FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('tags.view'));
CREATE POLICY tags_insert ON fintrace.tags FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('tags.create'));
CREATE POLICY tags_update ON fintrace.tags FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('tags.update'));

CREATE POLICY contacts_select ON fintrace.contacts FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('contacts.view'));
CREATE POLICY contacts_insert ON fintrace.contacts FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('contacts.create'));
CREATE POLICY contacts_update ON fintrace.contacts FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('contacts.update'));

CREATE POLICY accounts_select ON fintrace.accounts FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('accounts.view'));
CREATE POLICY accounts_insert ON fintrace.accounts FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('accounts.create'));
CREATE POLICY accounts_update ON fintrace.accounts FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('accounts.update'));

CREATE POLICY ledger_transactions_select ON fintrace.ledger_transactions FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('transactions.view'));
CREATE POLICY ledger_transactions_insert ON fintrace.ledger_transactions FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('transactions.create'));
CREATE POLICY ledger_transactions_update ON fintrace.ledger_transactions FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND (fintrace.has_permission('transactions.update') OR fintrace.has_permission('transactions.post')));

CREATE POLICY ledger_entries_select ON fintrace.ledger_entries FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('transactions.view'));
CREATE POLICY ledger_entries_insert ON fintrace.ledger_entries FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('transactions.create'));
CREATE POLICY ledger_entries_update ON fintrace.ledger_entries FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('transactions.update'));

CREATE POLICY income_records_select ON fintrace.income_records FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('income.view'));
CREATE POLICY income_records_insert ON fintrace.income_records FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('income.create'));
CREATE POLICY income_records_update ON fintrace.income_records FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('income.update'));

CREATE POLICY income_tags_isolation ON fintrace.income_tags
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('income.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND (fintrace.has_permission('income.create') OR fintrace.has_permission('income.update')));

CREATE POLICY expense_records_select ON fintrace.expense_records FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('expenses.view'));
CREATE POLICY expense_records_insert ON fintrace.expense_records FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('expenses.create'));
CREATE POLICY expense_records_update ON fintrace.expense_records FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('expenses.update'));

CREATE POLICY expense_tags_isolation ON fintrace.expense_tags
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('expenses.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND (fintrace.has_permission('expenses.create') OR fintrace.has_permission('expenses.update')));

CREATE POLICY debts_select ON fintrace.debts FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('debts.view'));
CREATE POLICY debts_insert ON fintrace.debts FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('debts.create'));
CREATE POLICY debts_update ON fintrace.debts FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('debts.update'));

CREATE POLICY debt_repayments_isolation ON fintrace.debt_repayments
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('debts.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('debts.update'));

CREATE POLICY investment_portfolios_isolation ON fintrace.investment_portfolios
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.create'));

CREATE POLICY investment_instruments_isolation ON fintrace.investment_instruments
    USING ((tenant_id IS NULL OR tenant_id = fintrace.current_tenant_id()) AND fintrace.has_permission('investments.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.create'));

CREATE POLICY investment_positions_isolation ON fintrace.investment_positions
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id());

CREATE POLICY investment_trades_isolation ON fintrace.investment_trades
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.create'));

CREATE POLICY investment_dividends_isolation ON fintrace.investment_dividends
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.create'));

CREATE POLICY assets_select ON fintrace.assets FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('assets.view'));
CREATE POLICY assets_insert ON fintrace.assets FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('assets.create'));
CREATE POLICY assets_update ON fintrace.assets FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('assets.update'));

CREATE POLICY asset_valuations_isolation ON fintrace.asset_valuations
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('assets.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('assets.update'));

CREATE POLICY goals_select ON fintrace.goals FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('goals.view'));
CREATE POLICY goals_insert ON fintrace.goals FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('goals.create'));
CREATE POLICY goals_update ON fintrace.goals FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('goals.update'));

CREATE POLICY goal_contributions_isolation ON fintrace.goal_contributions
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('goals.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('goals.update'));

CREATE POLICY subscriptions_select ON fintrace.subscriptions FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('subscriptions.view'));
CREATE POLICY subscriptions_insert ON fintrace.subscriptions FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('subscriptions.create'));
CREATE POLICY subscriptions_update ON fintrace.subscriptions FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('subscriptions.update'));

CREATE POLICY recurring_transactions_select ON fintrace.recurring_transactions FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('recurring.view'));
CREATE POLICY recurring_transactions_insert ON fintrace.recurring_transactions FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('recurring.create'));
CREATE POLICY recurring_transactions_update ON fintrace.recurring_transactions FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('recurring.update'));

CREATE POLICY recurring_occurrences_isolation ON fintrace.recurring_transaction_occurrences
    USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('recurring.view'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('recurring.update'));

CREATE POLICY rbac_roles_select ON fintrace.rbac_roles
    FOR SELECT USING ((tenant_id IS NULL OR tenant_id = fintrace.current_tenant_id()) AND fintrace.has_permission('roles.view'));
CREATE POLICY rbac_roles_insert ON fintrace.rbac_roles
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('roles.create'));
CREATE POLICY rbac_roles_update ON fintrace.rbac_roles
    FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('roles.update'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id());
CREATE POLICY rbac_roles_delete ON fintrace.rbac_roles
    FOR DELETE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('roles.delete'));

CREATE POLICY rbac_role_permissions_select ON fintrace.rbac_role_permissions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM fintrace.rbac_roles r
             WHERE r.id = role_id
               AND (r.tenant_id IS NULL OR r.tenant_id = fintrace.current_tenant_id())
        ) AND fintrace.has_permission('roles.view')
    );

CREATE POLICY rbac_role_permissions_insert ON fintrace.rbac_role_permissions
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM fintrace.rbac_roles r
             WHERE r.id = role_id
               AND r.tenant_id = fintrace.current_tenant_id()
        ) AND fintrace.has_permission('roles.update')
    );

CREATE POLICY rbac_role_permissions_update ON fintrace.rbac_role_permissions
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM fintrace.rbac_roles r
             WHERE r.id = role_id
               AND r.tenant_id = fintrace.current_tenant_id()
        ) AND fintrace.has_permission('roles.update')
    );

CREATE POLICY rbac_role_permissions_delete ON fintrace.rbac_role_permissions
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM fintrace.rbac_roles r
             WHERE r.id = role_id
               AND r.tenant_id = fintrace.current_tenant_id()
        ) AND fintrace.has_permission('roles.update')
    );

CREATE POLICY rbac_membership_roles_isolation ON fintrace.rbac_membership_roles
    USING (
        EXISTS (
            SELECT 1 FROM fintrace.tenant_memberships m
             WHERE m.id = membership_id
               AND m.tenant_id = fintrace.current_tenant_id()
        ) AND fintrace.has_permission('memberships.view')
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM fintrace.tenant_memberships m
             WHERE m.id = membership_id
               AND m.tenant_id = fintrace.current_tenant_id()
        ) AND fintrace.has_permission('memberships.update')
    );

CREATE POLICY rbac_user_override_isolation ON fintrace.rbac_user_permission_overrides
    USING (
        EXISTS (
            SELECT 1 FROM fintrace.tenant_memberships m
             WHERE m.id = membership_id
               AND m.tenant_id = fintrace.current_tenant_id()
        ) AND fintrace.has_permission('memberships.view')
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM fintrace.tenant_memberships m
             WHERE m.id = membership_id
               AND m.tenant_id = fintrace.current_tenant_id()
        ) AND fintrace.has_permission('memberships.update')
    );

-- -----------------------------------------------------------------------------
-- RLS protection for tenant root
-- -----------------------------------------------------------------------------

ALTER TABLE fintrace.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_isolation ON fintrace.tenants
    USING (id = fintrace.current_tenant_id())
    WITH CHECK (id = fintrace.current_tenant_id());

-- -----------------------------------------------------------------------------
-- Balance / derived-state views
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW fintrace.account_balances AS
SELECT
    a.id AS account_id,
    a.tenant_id,
    a.name,
    a.type,
    a.normal_balance,
    a.currency_id,
    COALESCE(
        SUM(
            CASE
                WHEN a.normal_balance = 'DEBIT'
                    THEN le.debit_amount - le.credit_amount
                ELSE
                    le.credit_amount - le.debit_amount
            END
        ) FILTER (WHERE lt.status = 'COMPLETED'),
        0
    ) AS balance_amount,
    COALESCE(
        SUM(
            CASE
                WHEN a.normal_balance = 'DEBIT'
                    THEN le.base_amount * CASE WHEN le.debit_amount > 0 THEN 1 ELSE -1 END
                ELSE
                    le.base_amount * CASE WHEN le.credit_amount > 0 THEN 1 ELSE -1 END
            END
        ) FILTER (WHERE lt.status = 'COMPLETED'),
        0
    ) AS balance_base_amount
FROM fintrace.accounts a
LEFT JOIN fintrace.ledger_entries le
       ON le.tenant_id = a.tenant_id
      AND le.account_id = a.id
LEFT JOIN fintrace.ledger_transactions lt
       ON lt.tenant_id = le.tenant_id
      AND lt.id = le.transaction_id
GROUP BY a.id, a.tenant_id, a.name, a.type, a.normal_balance, a.currency_id;

CREATE OR REPLACE VIEW fintrace.unbalanced_transactions AS
SELECT
    lt.id AS transaction_id,
    lt.tenant_id,
    lt.status,
    count(le.id) AS line_count,
    COALESCE(sum(le.base_amount) FILTER (WHERE le.debit_amount > 0),0) AS total_debits,
    COALESCE(sum(le.base_amount) FILTER (WHERE le.credit_amount > 0),0) AS total_credits
FROM fintrace.ledger_transactions lt
LEFT JOIN fintrace.ledger_entries le
       ON le.tenant_id = lt.tenant_id
      AND le.transaction_id = lt.id
WHERE lt.status = 'COMPLETED'
GROUP BY lt.id, lt.tenant_id, lt.status
HAVING count(le.id) < 2
    OR COALESCE(sum(le.base_amount) FILTER (WHERE le.debit_amount > 0),0) <= 0
    OR COALESCE(sum(le.base_amount) FILTER (WHERE le.credit_amount > 0),0) <= 0
    OR abs(COALESCE(sum(le.base_amount) FILTER (WHERE le.debit_amount > 0),0)
       - COALESCE(sum(le.base_amount) FILTER (WHERE le.credit_amount > 0),0)) > 0.01;

CREATE OR REPLACE VIEW fintrace.debt_balances AS
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
       ON r.tenant_id = d.tenant_id
      AND r.debt_id = d.id
GROUP BY d.id, d.tenant_id, d.type, d.contact_id,
         d.principal_amount, d.currency_id, d.status,
         d.start_date, d.due_date;

CREATE OR REPLACE VIEW fintrace.goal_progress AS
SELECT
    g.id AS goal_id,
    g.tenant_id,
    g.name,
    g.target_amount,
    g.currency_id,
    COALESCE(sum(c.amount),0) AS contributed_amount,
    GREATEST(g.target_amount - COALESCE(sum(c.amount),0), 0) AS remaining_amount,
    CASE
        WHEN g.target_amount = 0 THEN 0
        ELSE LEAST((COALESCE(sum(c.amount),0) / g.target_amount) * 100, 100)
    END AS progress_percent,
    g.target_date,
    g.priority,
    g.status
FROM fintrace.goals g
LEFT JOIN fintrace.goal_contributions c
       ON c.tenant_id = g.tenant_id
      AND c.goal_id = g.id
GROUP BY g.id, g.tenant_id, g.name, g.target_amount,
         g.currency_id, g.target_date, g.priority, g.status;

CREATE OR REPLACE VIEW fintrace.asset_current_valuations AS
SELECT DISTINCT ON (av.tenant_id, av.asset_id)
    av.asset_id,
    av.tenant_id,
    av.value,
    av.currency_id,
    av.valued_on,
    av.source
FROM fintrace.asset_valuations av
ORDER BY av.tenant_id, av.asset_id, av.valued_on DESC, av.created_at DESC;

CREATE OR REPLACE VIEW fintrace.investment_position_summary AS
SELECT
    p.id AS position_id,
    p.tenant_id,
    p.portfolio_id,
    p.instrument_id,
    p.quantity,
    p.average_cost,
    i.symbol,
    i.name AS instrument_name,
    i.currency_id AS instrument_currency_id,
    p.updated_at
FROM fintrace.investment_positions p
JOIN fintrace.investment_instruments i
  ON i.id = p.instrument_id;

CREATE OR REPLACE VIEW fintrace.data_integrity_issues AS
SELECT
    'UNBALANCED_LEDGER' AS issue_type,
    transaction_id AS entity_id,
    tenant_id,
    jsonb_build_object(
        'line_count', line_count,
        'total_debits', total_debits,
        'total_credits', total_credits
    ) AS details
FROM fintrace.unbalanced_transactions
UNION ALL
SELECT
    'NEGATIVE_DEBT_OUTSTANDING' AS issue_type,
    debt_id AS entity_id,
    tenant_id,
    jsonb_build_object('outstanding_principal', outstanding_principal) AS details
FROM fintrace.debt_balances
WHERE outstanding_principal < 0
UNION ALL
SELECT
    'PAID_DEBT_WITH_BALANCE' AS issue_type,
    debt_id AS entity_id,
    tenant_id,
    jsonb_build_object('outstanding_principal', outstanding_principal) AS details
FROM fintrace.debt_balances
WHERE status = 'PAID' AND outstanding_principal <> 0;

-- -----------------------------------------------------------------------------
-- RBAC seed catalog
-- -----------------------------------------------------------------------------

-- Bootstrap catalog rows have no tenant actor yet; disable only the two audit
-- triggers touched by global system-role seeding, then immediately restore them.
ALTER TABLE fintrace.rbac_roles DISABLE TRIGGER rbac_roles_audit;
ALTER TABLE fintrace.rbac_role_permissions DISABLE TRIGGER rbac_role_permissions_audit;

INSERT INTO fintrace.rbac_actions (code, name)
VALUES
    ('VIEW','View'),
    ('CREATE','Create'),
    ('UPDATE','Update'),
    ('ARCHIVE','Archive'),
    ('DELETE','Delete'),
    ('POST','Post'),
    ('REVERSE','Reverse'),
    ('EXPORT','Export'),
    ('MANAGE','Manage')
ON CONFLICT (code) DO NOTHING;

INSERT INTO fintrace.rbac_pages (code, name)
VALUES
    ('DASHBOARD','Dashboard'),
    ('ACCOUNTS','Accounts'),
    ('TRANSACTIONS','Transactions'),
    ('INCOME','Income'),
    ('EXPENSES','Expenses'),
    ('CATEGORIES','Categories'),
    ('TAGS','Tags'),
    ('CONTACTS','Contacts'),
    ('DEBTS','Debts'),
    ('INVESTMENTS','Investments'),
    ('ASSETS','Assets'),
    ('GOALS','Goals'),
    ('SUBSCRIPTIONS','Subscriptions'),
    ('RECURRING','Recurring Transactions'),
    ('USERS','Users'),
    ('MEMBERSHIPS','Memberships'),
    ('ROLES','Roles'),
    ('AUDIT','Audit Log'),
    ('SETTINGS','Settings')
ON CONFLICT (code) DO NOTHING;

INSERT INTO fintrace.rbac_permissions (page_id, action_id, code, description)
SELECT p.id, a.id, lower(p.code) || '.' || lower(a.code), p.name || ' - ' || a.name
FROM fintrace.rbac_pages p
CROSS JOIN fintrace.rbac_actions a
ON CONFLICT (code) DO NOTHING;

INSERT INTO fintrace.rbac_roles (tenant_id, code, name, description, is_system)
SELECT v.tenant_id, v.code, v.name, v.description, v.is_system
FROM (VALUES
    (NULL::UUID, 'ADMIN', 'Administrator', 'Full tenant administration', TRUE),
    (NULL::UUID, 'MEMBER', 'Member', 'Standard tenant member access', TRUE),
    (NULL::UUID, 'VIEWER', 'Viewer', 'Read-only tenant access', TRUE)
) AS v(tenant_id, code, name, description, is_system)
WHERE NOT EXISTS (
    SELECT 1 FROM fintrace.rbac_roles r
     WHERE r.tenant_id IS NULL AND r.code = v.code
);

INSERT INTO fintrace.rbac_role_permissions (role_id, permission_id, access_scope)
SELECT r.id, p.id, 'TENANT'
FROM fintrace.rbac_roles r
JOIN fintrace.rbac_permissions p ON TRUE
WHERE r.code = 'ADMIN' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO fintrace.rbac_role_permissions (role_id, permission_id, access_scope)
SELECT r.id, p.id, 'TENANT'
FROM fintrace.rbac_roles r
JOIN fintrace.rbac_permissions p
  ON p.code IN (
      'dashboard.view',
      'accounts.view','accounts.create','accounts.update',
      'transactions.view','transactions.create','transactions.update','transactions.post','transactions.reverse',
      'income.view','income.create','income.update',
      'expenses.view','expenses.create','expenses.update',
      'categories.view','categories.create','categories.update',
      'tags.view','tags.create','tags.update',
      'contacts.view','contacts.create','contacts.update',
      'debts.view','debts.create','debts.update',
      'investments.view','investments.create','investments.update',
      'assets.view','assets.create','assets.update',
      'goals.view','goals.create','goals.update',
      'subscriptions.view','subscriptions.create','subscriptions.update',
      'recurring.view','recurring.create','recurring.update'
  )
WHERE r.code = 'MEMBER' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO fintrace.rbac_role_permissions (role_id, permission_id, access_scope)
SELECT r.id, p.id, 'TENANT'
FROM fintrace.rbac_roles r
JOIN fintrace.rbac_permissions p
  ON p.code IN (
      'dashboard.view','accounts.view','transactions.view','income.view','expenses.view',
      'categories.view','tags.view','contacts.view','debts.view','investments.view',
      'assets.view','goals.view','subscriptions.view','recurring.view'
  )
WHERE r.code = 'VIEWER' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

ALTER TABLE fintrace.rbac_roles ENABLE TRIGGER rbac_roles_audit;
ALTER TABLE fintrace.rbac_role_permissions ENABLE TRIGGER rbac_role_permissions_audit;

CREATE OR REPLACE FUNCTION fintrace.protect_global_role_permissions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_role_id UUID;
    v_tenant_id UUID;
    v_is_system BOOLEAN;
BEGIN
    v_role_id := COALESCE(NEW.role_id, OLD.role_id);
    SELECT tenant_id, is_system INTO v_tenant_id, v_is_system
      FROM fintrace.rbac_roles
     WHERE id = v_role_id;

    IF v_tenant_id IS NULL AND v_is_system THEN
        RAISE EXCEPTION 'System role permissions are controlled by the global RBAC catalog'
            USING ERRCODE = '25006';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER rbac_role_permissions_global_no_mutation
BEFORE INSERT OR UPDATE OR DELETE ON fintrace.rbac_role_permissions
FOR EACH ROW
EXECUTE FUNCTION fintrace.protect_global_role_permissions();

-- =============================================================================
-- Production hardening patch
-- =============================================================================
-- This section closes architectural gaps found during review while preserving
-- the public Fintrace data model wherever possible.

-- -----------------------------------------------------------------------------
-- Signed session context: never trust tenant/user GUCs without validation
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.security_config (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    context_hmac_secret BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO fintrace.security_config (singleton, context_hmac_secret)
VALUES (TRUE, gen_random_bytes(32))
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION fintrace.context_signature(p_user_id UUID, p_tenant_id UUID)
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
    SELECT encode(
        public.hmac(
            convert_to(
                p_user_id::TEXT || '|' || p_tenant_id::TEXT || '|' ||
                pg_backend_pid()::TEXT || '|' || session_user,
                'UTF8'
            ),
            sc.context_hmac_secret,
            'sha256'
        ),
        'hex'
    )
    FROM fintrace.security_config sc
    WHERE sc.singleton;
$$;

CREATE OR REPLACE FUNCTION fintrace.context_is_valid()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_user_text TEXT;
    v_tenant_text TEXT;
    v_signature TEXT;
    v_user UUID;
    v_tenant UUID;
    v_expected TEXT;
BEGIN
    v_user_text := NULLIF(current_setting('fintrace.current_user_id', true), '');
    v_tenant_text := NULLIF(current_setting('fintrace.current_tenant_id', true), '');
    v_signature := NULLIF(current_setting('fintrace.context_signature', true), '');

    IF v_user_text IS NULL OR v_tenant_text IS NULL OR v_signature IS NULL THEN
        RETURN FALSE;
    END IF;

    BEGIN
        v_user := v_user_text::UUID;
        v_tenant := v_tenant_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN FALSE;
    END;

    SELECT fintrace.context_signature(v_user, v_tenant) INTO v_expected;
    RETURN v_expected IS NOT NULL AND v_signature = v_expected;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.current_tenant_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
BEGIN
    IF NOT fintrace.context_is_valid() THEN
        RETURN NULL;
    END IF;
    RETURN NULLIF(current_setting('fintrace.current_tenant_id', true), '')::UUID;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.current_user_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
BEGIN
    IF NOT fintrace.context_is_valid() THEN
        RETURN NULL;
    END IF;
    RETURN NULLIF(current_setting('fintrace.current_user_id', true), '')::UUID;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.set_context(p_user_id UUID, p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_signature TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM fintrace.users u
          JOIN fintrace.tenant_memberships m ON m.user_id = u.id
          JOIN fintrace.tenants t ON t.id = m.tenant_id
         WHERE u.id = p_user_id
           AND u.status = 'ACTIVE'
           AND m.tenant_id = p_tenant_id
           AND m.status = 'ACTIVE'
           AND t.status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'User is not an active member of the requested active tenant'
            USING ERRCODE = '42501';
    END IF;

    v_signature := fintrace.context_signature(p_user_id, p_tenant_id);
    IF v_signature IS NULL THEN
        RAISE EXCEPTION 'Session context signing key is unavailable' USING ERRCODE = '55000';
    END IF;

    -- Transaction-local settings prevent context leakage through pooled sessions.
    PERFORM set_config('fintrace.current_user_id', p_user_id::TEXT, true);
    PERFORM set_config('fintrace.current_tenant_id', p_tenant_id::TEXT, true);
    PERFORM set_config('fintrace.context_signature', v_signature, true);
END;
$$;

-- -----------------------------------------------------------------------------
-- RBAC scope hardening
-- OWN was represented in the catalog but no business row ownership dimension
-- existed. Remove the unsupported scope instead of presenting a false boundary.
-- -----------------------------------------------------------------------------

ALTER TABLE fintrace.rbac_role_permissions
    DROP CONSTRAINT IF EXISTS rbac_role_permissions_scope_ck;
ALTER TABLE fintrace.rbac_role_permissions
    ADD CONSTRAINT rbac_role_permissions_scope_ck CHECK (access_scope = 'TENANT');

ALTER TABLE fintrace.rbac_user_permission_overrides
    DROP CONSTRAINT IF EXISTS rbac_user_permission_overrides_scope_ck;
ALTER TABLE fintrace.rbac_user_permission_overrides
    ADD CONSTRAINT rbac_user_permission_overrides_scope_ck CHECK (access_scope = 'TENANT');

SET LOCAL check_function_bodies = off;

CREATE OR REPLACE FUNCTION fintrace.has_permission(
    p_permission_code TEXT,
    p_required_scope TEXT DEFAULT 'TENANT'
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
WITH ctx AS (
    SELECT fintrace.current_tenant_id() AS tenant_id,
           fintrace.current_user_id() AS user_id
),
m AS (
    SELECT tm.id
      FROM fintrace.tenant_memberships tm
      JOIN ctx ON ctx.tenant_id = tm.tenant_id AND ctx.user_id = tm.user_id
     WHERE tm.status = 'ACTIVE'
       AND p_required_scope = 'TENANT'
),
override AS (
    SELECT o.effect
      FROM fintrace.rbac_user_permission_overrides o
      JOIN m ON m.id = o.membership_id
      JOIN fintrace.rbac_permissions p ON p.id = o.permission_id
     WHERE p.code = p_permission_code
       AND p.is_active
       AND o.access_scope = 'TENANT'
       AND (o.expires_at IS NULL OR o.expires_at > clock_timestamp())
)
SELECT CASE
    WHEN p_required_scope <> 'TENANT' THEN FALSE
    WHEN EXISTS (SELECT 1 FROM override WHERE effect = 'DENY') THEN FALSE
    WHEN EXISTS (SELECT 1 FROM override WHERE effect = 'ALLOW') THEN TRUE
    ELSE EXISTS (
        SELECT 1
          FROM m
          JOIN fintrace.rbac_membership_roles mr ON mr.membership_id = m.id
          JOIN fintrace.rbac_roles r ON r.id = mr.role_id
          JOIN fintrace.rbac_role_permissions rp ON rp.role_id = r.id
          JOIN fintrace.rbac_permissions p ON p.id = rp.permission_id
          JOIN ctx ON TRUE
         WHERE r.is_active
           AND p.is_active
           AND p.code = p_permission_code
           AND rp.access_scope = 'TENANT'
           AND (r.tenant_id IS NULL OR r.tenant_id = ctx.tenant_id)
    )
END;
$$;

-- -----------------------------------------------------------------------------
-- Currency precision helpers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.currency_quantum(p_currency_id UUID)
RETURNS NUMERIC
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
    SELECT power(10::NUMERIC, -c.decimal_places)
      FROM fintrace.currencies c
     WHERE c.id = p_currency_id;
$$;

CREATE OR REPLACE FUNCTION fintrace.currency_tolerance(p_currency_id UUID)
RETURNS NUMERIC
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
    SELECT fintrace.currency_quantum(p_currency_id) / 2;
$$;

-- Drop dependent views before widening financial precision.
DROP VIEW IF EXISTS fintrace.data_integrity_issues;
DROP VIEW IF EXISTS fintrace.investment_position_summary;
DROP VIEW IF EXISTS fintrace.asset_current_valuations;
DROP VIEW IF EXISTS fintrace.goal_progress;
DROP VIEW IF EXISTS fintrace.debt_balances;
DROP VIEW IF EXISTS fintrace.unbalanced_transactions;
DROP VIEW IF EXISTS fintrace.account_balances;

-- Widen all monetary data to the advertised maximum currency precision.
ALTER TABLE fintrace.ledger_entries
    DROP CONSTRAINT IF EXISTS ledger_entries_base_round_ck;

ALTER TABLE fintrace.ledger_entries
    ALTER COLUMN amount TYPE NUMERIC(28,8),
    ALTER COLUMN debit_amount TYPE NUMERIC(28,8),
    ALTER COLUMN credit_amount TYPE NUMERIC(28,8),
    ALTER COLUMN exchange_rate TYPE NUMERIC(28,12),
    ALTER COLUMN base_amount TYPE NUMERIC(28,8);

DROP TRIGGER debts_identity_immutable_after_repayment ON fintrace.debts;
ALTER TABLE fintrace.income_records ALTER COLUMN amount TYPE NUMERIC(28,8);
ALTER TABLE fintrace.expense_records ALTER COLUMN amount TYPE NUMERIC(28,8);
ALTER TABLE fintrace.debts ALTER COLUMN principal_amount TYPE NUMERIC(28,8);
ALTER TABLE fintrace.debt_repayments DROP COLUMN total_amount;
ALTER TABLE fintrace.debt_repayments
    ALTER COLUMN principal_amount TYPE NUMERIC(28,8),
    ALTER COLUMN interest_amount TYPE NUMERIC(28,8);
ALTER TABLE fintrace.debt_repayments
    ADD COLUMN total_amount NUMERIC(28,8)
    GENERATED ALWAYS AS (principal_amount + interest_amount) STORED;
ALTER TABLE fintrace.investment_positions
    ALTER COLUMN average_cost TYPE NUMERIC(28,8);
CREATE TRIGGER debts_identity_immutable_after_repayment
BEFORE UPDATE OF type, contact_id, principal_amount, currency_id, start_date ON fintrace.debts
FOR EACH ROW
EXECUTE FUNCTION fintrace.protect_debt_identity_after_repayment();
ALTER TABLE fintrace.investment_trades
    ALTER COLUMN price TYPE NUMERIC(28,8),
    ALTER COLUMN fees TYPE NUMERIC(28,8),
    ALTER COLUMN realized_pnl TYPE NUMERIC(28,8);
ALTER TABLE fintrace.investment_dividends ALTER COLUMN amount TYPE NUMERIC(28,8);
ALTER TABLE fintrace.assets ALTER COLUMN purchase_value TYPE NUMERIC(28,8);
ALTER TABLE fintrace.asset_valuations ALTER COLUMN value TYPE NUMERIC(28,8);
ALTER TABLE fintrace.goals ALTER COLUMN target_amount TYPE NUMERIC(28,8);
ALTER TABLE fintrace.goal_contributions ALTER COLUMN amount TYPE NUMERIC(28,8);
ALTER TABLE fintrace.subscriptions ALTER COLUMN amount TYPE NUMERIC(28,8);
ALTER TABLE fintrace.recurring_transactions ALTER COLUMN amount TYPE NUMERIC(28,8);

-- -----------------------------------------------------------------------------
-- Ledger concurrency + currency precision enforcement
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.validate_ledger_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_account_currency UUID;
    v_account_active BOOLEAN;
    v_entry_decimals INTEGER;
    v_tenant_currency UUID;
    v_base_decimals INTEGER;
    v_tx_status TEXT;
    v_tx_is_reversal BOOLEAN;
    v_expected_base NUMERIC(28,8);
BEGIN
    -- Serialize every entry mutation against posting/cancellation of its parent.
    SELECT status, reverses_transaction_id IS NOT NULL
      INTO v_tx_status, v_tx_is_reversal
      FROM fintrace.ledger_transactions
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.transaction_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ledger transaction % does not exist for tenant %', NEW.transaction_id, NEW.tenant_id
            USING ERRCODE = '23503';
    END IF;

    IF v_tx_status IN ('COMPLETED','FAILED','CANCELLED') THEN
        RAISE EXCEPTION 'Ledger entries cannot be modified after transaction is terminal'
            USING ERRCODE = '25006';
    END IF;

    SELECT a.currency_id, a.is_active, c.decimal_places
      INTO v_account_currency, v_account_active, v_entry_decimals
      FROM fintrace.accounts a
      JOIN fintrace.currencies c ON c.id = a.currency_id
     WHERE a.tenant_id = NEW.tenant_id
       AND a.id = NEW.account_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Account % does not belong to tenant %', NEW.account_id, NEW.tenant_id
            USING ERRCODE = '23503';
    END IF;

    IF NOT v_account_active AND NOT v_tx_is_reversal THEN
        RAISE EXCEPTION 'New ledger entries cannot use an inactive account unless the transaction is a reversal'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.currency_id <> v_account_currency THEN
        RAISE EXCEPTION 'Ledger entry currency must equal account currency'
            USING ERRCODE = '23514';
    END IF;

    SELECT t.base_currency_id, c.decimal_places
      INTO v_tenant_currency, v_base_decimals
      FROM fintrace.tenants t
      JOIN fintrace.currencies c ON c.id = t.base_currency_id
     WHERE t.id = NEW.tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tenant % does not exist', NEW.tenant_id USING ERRCODE = '23503';
    END IF;

    IF NEW.currency_id = v_tenant_currency AND NEW.exchange_rate <> 1 THEN
        RAISE EXCEPTION 'Exchange rate must be 1 for tenant base currency entries'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.currency_id <> v_tenant_currency AND NEW.exchange_rate = 1 THEN
        RAISE EXCEPTION 'Non-base currency ledger entries require an explicit exchange rate'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.amount <> round(NEW.amount, v_entry_decimals)
       OR NEW.debit_amount <> round(NEW.debit_amount, v_entry_decimals)
       OR NEW.credit_amount <> round(NEW.credit_amount, v_entry_decimals) THEN
        RAISE EXCEPTION 'Ledger entry precision exceeds the currency decimal places (%)', v_entry_decimals
            USING ERRCODE = '22003';
    END IF;

    v_expected_base := round(NEW.amount * NEW.exchange_rate, v_base_decimals);
    IF NEW.base_amount <> v_expected_base THEN
        RAISE EXCEPTION 'base_amount % must equal amount × exchange_rate rounded to base-currency precision (%) = %',
            NEW.base_amount, v_base_decimals, v_expected_base
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.block_ledger_entry_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status
      INTO v_status
      FROM fintrace.ledger_transactions
     WHERE tenant_id = OLD.tenant_id
       AND id = OLD.transaction_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Parent ledger transaction does not exist' USING ERRCODE = '23503';
    END IF;

    IF v_status IN ('COMPLETED','FAILED','CANCELLED') THEN
        RAISE EXCEPTION 'Ledger entries cannot be deleted after transaction is terminal'
            USING ERRCODE = '25006';
    END IF;

    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.validate_completed_transaction(p_transaction_id UUID, p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
    v_line_count INTEGER;
    v_debit NUMERIC(38,8);
    v_credit NUMERIC(38,8);
    v_base_currency UUID;
    v_tolerance NUMERIC;
BEGIN
    SELECT lt.status, t.base_currency_id
      INTO v_status, v_base_currency
      FROM fintrace.ledger_transactions lt
      JOIN fintrace.tenants t ON t.id = lt.tenant_id
     WHERE lt.tenant_id = p_tenant_id
       AND lt.id = p_transaction_id
     FOR UPDATE OF lt;

    IF NOT FOUND OR v_status <> 'COMPLETED' THEN
        RETURN;
    END IF;

    SELECT count(*),
           COALESCE(sum(base_amount) FILTER (WHERE debit_amount > 0), 0),
           COALESCE(sum(base_amount) FILTER (WHERE credit_amount > 0), 0)
      INTO v_line_count, v_debit, v_credit
      FROM fintrace.ledger_entries
     WHERE tenant_id = p_tenant_id
       AND transaction_id = p_transaction_id;

    v_tolerance := fintrace.currency_tolerance(v_base_currency);

    IF v_line_count < 2 THEN
        RAISE EXCEPTION 'Completed ledger transaction % must have at least two entries', p_transaction_id
            USING ERRCODE = '23514';
    END IF;

    IF v_debit <= 0 OR v_credit <= 0 OR abs(v_debit - v_credit) > v_tolerance THEN
        RAISE EXCEPTION 'Completed ledger transaction % is not balanced in tenant base currency (debit %, credit %, tolerance %)',
            p_transaction_id, v_debit, v_credit, v_tolerance
            USING ERRCODE = '23514';
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Investment referential integrity and exact ledger mapping
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.validate_instrument_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_instrument_tenant UUID;
BEGIN
    SELECT tenant_id
      INTO v_instrument_tenant
      FROM fintrace.investment_instruments
     WHERE id = NEW.instrument_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Investment instrument % does not exist', NEW.instrument_id
            USING ERRCODE = '23503';
    END IF;

    IF v_instrument_tenant IS NOT NULL AND v_instrument_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION 'Investment instrument % belongs to a different tenant', NEW.instrument_id
            USING ERRCODE = '23503';
    END IF;

    RETURN NEW;
END;
$$;

ALTER TABLE fintrace.investment_trades
    ADD COLUMN cash_account_id UUID,
    ADD COLUMN investment_account_id UUID,
    ADD COLUMN realized_pnl_account_id UUID;

ALTER TABLE fintrace.investment_trades
    ADD CONSTRAINT investment_trades_cash_account_fk
        FOREIGN KEY (tenant_id, cash_account_id) REFERENCES fintrace.accounts(tenant_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT investment_trades_investment_account_fk
        FOREIGN KEY (tenant_id, investment_account_id) REFERENCES fintrace.accounts(tenant_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT investment_trades_pnl_account_fk
        FOREIGN KEY (tenant_id, realized_pnl_account_id) REFERENCES fintrace.accounts(tenant_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT investment_trades_account_requirements_ck CHECK (
        cash_account_id IS NOT NULL
        AND investment_account_id IS NOT NULL
        AND (trade_type <> 'SELL' OR realized_pnl_account_id IS NOT NULL)
        AND cash_account_id <> investment_account_id
        AND (realized_pnl_account_id IS NULL OR realized_pnl_account_id NOT IN (cash_account_id, investment_account_id))
    );

ALTER TABLE fintrace.investment_dividends
    ADD COLUMN cash_account_id UUID,
    ADD COLUMN income_account_id UUID;

ALTER TABLE fintrace.investment_dividends
    ADD CONSTRAINT investment_dividends_cash_account_fk
        FOREIGN KEY (tenant_id, cash_account_id) REFERENCES fintrace.accounts(tenant_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT investment_dividends_income_account_fk
        FOREIGN KEY (tenant_id, income_account_id) REFERENCES fintrace.accounts(tenant_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT investment_dividends_accounts_ck CHECK (
        cash_account_id IS NOT NULL
        AND income_account_id IS NOT NULL
        AND cash_account_id <> income_account_id
    );

CREATE OR REPLACE FUNCTION fintrace.validate_investment_account_currency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_currency UUID;
    v_account_currency UUID;
BEGIN
    SELECT currency_id INTO v_currency
      FROM fintrace.investment_instruments
     WHERE id = NEW.instrument_id
       AND (tenant_id IS NULL OR tenant_id = NEW.tenant_id);

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Investment instrument does not exist for tenant' USING ERRCODE = '23503';
    END IF;

    IF TG_TABLE_NAME = 'investment_trades' THEN
        SELECT currency_id INTO v_account_currency FROM fintrace.accounts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.cash_account_id;
        IF v_account_currency IS DISTINCT FROM v_currency THEN
            RAISE EXCEPTION 'Investment trade cash account currency must match instrument currency' USING ERRCODE = '23514';
        END IF;

        SELECT currency_id INTO v_account_currency FROM fintrace.accounts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.investment_account_id;
        IF v_account_currency IS DISTINCT FROM v_currency THEN
            RAISE EXCEPTION 'Investment asset account currency must match instrument currency' USING ERRCODE = '23514';
        END IF;

        IF NEW.realized_pnl_account_id IS NOT NULL THEN
            SELECT currency_id INTO v_account_currency FROM fintrace.accounts
             WHERE tenant_id = NEW.tenant_id AND id = NEW.realized_pnl_account_id;
            IF v_account_currency IS DISTINCT FROM v_currency THEN
                RAISE EXCEPTION 'Realized P&L account currency must match instrument currency' USING ERRCODE = '23514';
            END IF;
        END IF;
    ELSE
        IF NEW.currency_id <> v_currency THEN
            RAISE EXCEPTION 'Dividend currency must match instrument currency' USING ERRCODE = '23514';
        END IF;

        SELECT currency_id INTO v_account_currency FROM fintrace.accounts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.cash_account_id;
        IF v_account_currency IS DISTINCT FROM NEW.currency_id THEN
            RAISE EXCEPTION 'Dividend cash account currency must match dividend currency' USING ERRCODE = '23514';
        END IF;

        SELECT currency_id INTO v_account_currency FROM fintrace.accounts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.income_account_id;
        IF v_account_currency IS DISTINCT FROM NEW.currency_id THEN
            RAISE EXCEPTION 'Dividend income account currency must match dividend currency' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER investment_trade_account_currency_validate
BEFORE INSERT OR UPDATE OF instrument_id, cash_account_id, investment_account_id, realized_pnl_account_id
ON fintrace.investment_trades
FOR EACH ROW EXECUTE FUNCTION fintrace.validate_investment_account_currency();

CREATE TRIGGER investment_dividend_account_currency_validate
BEFORE INSERT OR UPDATE OF instrument_id, currency_id, cash_account_id, income_account_id
ON fintrace.investment_dividends
FOR EACH ROW EXECUTE FUNCTION fintrace.validate_investment_account_currency();

CREATE OR REPLACE FUNCTION fintrace.validate_investment_trade_ledger_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_currency UUID;
    v_decimals INTEGER;
    v_gross NUMERIC(28,8);
    v_cash NUMERIC(28,8);
    v_cost_basis NUMERIC(28,8);
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_transactions
         WHERE tenant_id = NEW.tenant_id
           AND id = NEW.ledger_transaction_id
           AND status = 'COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Investment trade requires a COMPLETED ledger transaction' USING ERRCODE = '23514';
    END IF;

    SELECT i.currency_id, c.decimal_places
      INTO v_currency, v_decimals
      FROM fintrace.investment_instruments i
      JOIN fintrace.currencies c ON c.id = i.currency_id
     WHERE i.id = NEW.instrument_id
       AND (i.tenant_id IS NULL OR i.tenant_id = NEW.tenant_id);

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Investment instrument does not exist for tenant' USING ERRCODE = '23503';
    END IF;

    v_gross := round(NEW.quantity * NEW.price, v_decimals);

    IF NEW.trade_type = 'BUY' THEN
        v_cash := round(v_gross + NEW.fees, v_decimals);

        IF NOT EXISTS (
            SELECT 1 FROM fintrace.ledger_entries
             WHERE tenant_id = NEW.tenant_id
               AND transaction_id = NEW.ledger_transaction_id
               AND account_id = NEW.investment_account_id
               AND currency_id = v_currency
               AND debit_amount = v_cash
        ) OR NOT EXISTS (
            SELECT 1 FROM fintrace.ledger_entries
             WHERE tenant_id = NEW.tenant_id
               AND transaction_id = NEW.ledger_transaction_id
               AND account_id = NEW.cash_account_id
               AND currency_id = v_currency
               AND credit_amount = v_cash
        ) THEN
            RAISE EXCEPTION 'BUY trade ledger must debit the investment account and credit cash for gross cost plus fees (%)', v_cash
                USING ERRCODE = '23514';
        END IF;
    ELSE
        v_cash := round(v_gross - NEW.fees, v_decimals);
        v_cost_basis := round(v_cash - NEW.realized_pnl, v_decimals);

        IF v_cash < 0 OR v_cost_basis < 0 THEN
            RAISE EXCEPTION 'SELL trade produces invalid settlement or cost basis' USING ERRCODE = '23514';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM fintrace.ledger_entries
             WHERE tenant_id = NEW.tenant_id
               AND transaction_id = NEW.ledger_transaction_id
               AND account_id = NEW.cash_account_id
               AND currency_id = v_currency
               AND debit_amount = v_cash
        ) OR NOT EXISTS (
            SELECT 1 FROM fintrace.ledger_entries
             WHERE tenant_id = NEW.tenant_id
               AND transaction_id = NEW.ledger_transaction_id
               AND account_id = NEW.investment_account_id
               AND currency_id = v_currency
               AND credit_amount = v_cost_basis
        ) THEN
            RAISE EXCEPTION 'SELL trade ledger must debit cash for net proceeds and credit the investment account for cost basis'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.realized_pnl > 0 AND NOT EXISTS (
            SELECT 1 FROM fintrace.ledger_entries
             WHERE tenant_id = NEW.tenant_id
               AND transaction_id = NEW.ledger_transaction_id
               AND account_id = NEW.realized_pnl_account_id
               AND currency_id = v_currency
               AND credit_amount = round(NEW.realized_pnl, v_decimals)
        ) THEN
            RAISE EXCEPTION 'Positive realized P&L must be credited to realized_pnl_account_id' USING ERRCODE = '23514';
        ELSIF NEW.realized_pnl < 0 AND NOT EXISTS (
            SELECT 1 FROM fintrace.ledger_entries
             WHERE tenant_id = NEW.tenant_id
               AND transaction_id = NEW.ledger_transaction_id
               AND account_id = NEW.realized_pnl_account_id
               AND currency_id = v_currency
               AND debit_amount = round(abs(NEW.realized_pnl), v_decimals)
        ) THEN
            RAISE EXCEPTION 'Negative realized P&L must be debited to realized_pnl_account_id' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.validate_investment_dividend_ledger_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_transactions
         WHERE tenant_id = NEW.tenant_id
           AND id = NEW.ledger_transaction_id
           AND status = 'COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Investment dividend requires a COMPLETED ledger transaction' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_entries
         WHERE tenant_id = NEW.tenant_id
           AND transaction_id = NEW.ledger_transaction_id
           AND account_id = NEW.cash_account_id
           AND currency_id = NEW.currency_id
           AND debit_amount = NEW.amount
    ) OR NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_entries
         WHERE tenant_id = NEW.tenant_id
           AND transaction_id = NEW.ledger_transaction_id
           AND account_id = NEW.income_account_id
           AND currency_id = NEW.currency_id
           AND credit_amount = NEW.amount
    ) THEN
        RAISE EXCEPTION 'Dividend ledger must debit cash and credit dividend income for the dividend amount'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS investment_trade_ledger_link_ct ON fintrace.investment_trades;
CREATE CONSTRAINT TRIGGER investment_trade_ledger_link_ct
AFTER INSERT ON fintrace.investment_trades
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_investment_trade_ledger_link();

DROP TRIGGER IF EXISTS investment_dividend_ledger_link_ct ON fintrace.investment_dividends;
CREATE CONSTRAINT TRIGGER investment_dividend_ledger_link_ct
AFTER INSERT ON fintrace.investment_dividends
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION fintrace.validate_investment_dividend_ledger_link();

-- -----------------------------------------------------------------------------
-- Debt repayment: principal and interest are separate accounting components
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.validate_debt_repayment_ledger_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_currency UUID;
    v_type TEXT;
    v_opposite_sum NUMERIC(38,8);
BEGIN
    SELECT currency_id, type
      INTO v_currency, v_type
      FROM fintrace.debts
     WHERE tenant_id = NEW.tenant_id AND id = NEW.debt_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Debt does not exist for tenant' USING ERRCODE = '23503';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_transactions
         WHERE tenant_id = NEW.tenant_id
           AND id = NEW.ledger_transaction_id
           AND status = 'COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Debt repayments require a COMPLETED ledger transaction' USING ERRCODE = '23514';
    END IF;

    IF NEW.principal_amount > 0 AND NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_entries le
         WHERE le.tenant_id = NEW.tenant_id
           AND le.transaction_id = NEW.ledger_transaction_id
           AND le.currency_id = v_currency
           AND le.amount = NEW.principal_amount
           AND ((v_type = 'PAYABLE' AND le.debit_amount = NEW.principal_amount)
             OR (v_type = 'RECEIVABLE' AND le.credit_amount = NEW.principal_amount))
    ) THEN
        RAISE EXCEPTION 'Debt repayment principal must have its own matching ledger entry' USING ERRCODE = '23514';
    END IF;

    IF NEW.interest_amount > 0 AND NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_entries le
         WHERE le.tenant_id = NEW.tenant_id
           AND le.transaction_id = NEW.ledger_transaction_id
           AND le.currency_id = v_currency
           AND le.amount = NEW.interest_amount
           AND ((v_type = 'PAYABLE' AND le.debit_amount = NEW.interest_amount)
             OR (v_type = 'RECEIVABLE' AND le.credit_amount = NEW.interest_amount))
    ) THEN
        RAISE EXCEPTION 'Debt repayment interest must have its own matching ledger entry' USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(sum(
        CASE
            WHEN v_type = 'PAYABLE' THEN le.credit_amount
            ELSE le.debit_amount
        END
    ), 0)
      INTO v_opposite_sum
      FROM fintrace.ledger_entries le
     WHERE le.tenant_id = NEW.tenant_id
       AND le.transaction_id = NEW.ledger_transaction_id
       AND le.currency_id = v_currency;

    IF v_opposite_sum <> NEW.total_amount THEN
        RAISE EXCEPTION 'Debt repayment settlement side (%) must equal principal + interest (%)',
            v_opposite_sum, NEW.total_amount USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

-- Helper used by transaction-level validation because trigger functions cannot
-- be invoked directly with a RECORD argument.
CREATE OR REPLACE FUNCTION fintrace.validate_debt_repayment_by_id(
    p_tenant_id UUID,
    p_repayment_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    r fintrace.debt_repayments%ROWTYPE;
BEGIN
    SELECT * INTO r
      FROM fintrace.debt_repayments
     WHERE tenant_id = p_tenant_id AND id = p_repayment_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Reuse the same invariant directly.
    IF NOT EXISTS (
        SELECT 1 FROM fintrace.ledger_transactions
         WHERE tenant_id = r.tenant_id
           AND id = r.ledger_transaction_id
           AND status = 'COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Debt repayment requires a COMPLETED ledger transaction' USING ERRCODE = '23514';
    END IF;

    IF r.principal_amount > 0 AND NOT EXISTS (
        SELECT 1
          FROM fintrace.ledger_entries le
          JOIN fintrace.debts d ON d.tenant_id = r.tenant_id AND d.id = r.debt_id
         WHERE le.tenant_id = r.tenant_id
           AND le.transaction_id = r.ledger_transaction_id
           AND le.currency_id = d.currency_id
           AND le.amount = r.principal_amount
           AND ((d.type = 'PAYABLE' AND le.debit_amount = r.principal_amount)
             OR (d.type = 'RECEIVABLE' AND le.credit_amount = r.principal_amount))
    ) THEN
        RAISE EXCEPTION 'Debt repayment principal is not represented by its ledger transaction' USING ERRCODE = '23514';
    END IF;

    IF r.interest_amount > 0 AND NOT EXISTS (
        SELECT 1
          FROM fintrace.ledger_entries le
          JOIN fintrace.debts d ON d.tenant_id = r.tenant_id AND d.id = r.debt_id
         WHERE le.tenant_id = r.tenant_id
           AND le.transaction_id = r.ledger_transaction_id
           AND le.currency_id = d.currency_id
           AND le.amount = r.interest_amount
           AND ((d.type = 'PAYABLE' AND le.debit_amount = r.interest_amount)
             OR (d.type = 'RECEIVABLE' AND le.credit_amount = r.interest_amount))
    ) THEN
        RAISE EXCEPTION 'Debt repayment interest is not represented by its ledger transaction' USING ERRCODE = '23514';
    END IF;
END;
$$;

-- Replace the transaction metadata function once more without an invalid trigger
-- function call, using the id-based helper above.
CREATE OR REPLACE FUNCTION fintrace.validate_transaction_metadata(
    p_transaction_id UUID,
    p_tenant_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
    v_currency UUID;
    v_amount NUMERIC(28,8);
    v_repayment_id UUID;
BEGIN
    SELECT status INTO v_status
      FROM fintrace.ledger_transactions
     WHERE tenant_id = p_tenant_id AND id = p_transaction_id;

    IF v_status IS NULL THEN
        RETURN;
    END IF;

    FOR v_amount, v_currency IN
        SELECT amount, currency_id FROM fintrace.income_records
         WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id
    LOOP
        IF v_status <> 'COMPLETED' OR NOT EXISTS (
            SELECT 1 FROM fintrace.ledger_entries
             WHERE tenant_id = p_tenant_id AND transaction_id = p_transaction_id
               AND currency_id = v_currency AND credit_amount = v_amount
        ) THEN
            RAISE EXCEPTION 'Income record is not represented by a completed ledger transaction' USING ERRCODE = '23514';
        END IF;
    END LOOP;

    FOR v_amount, v_currency IN
        SELECT amount, currency_id FROM fintrace.expense_records
         WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id
    LOOP
        IF v_status <> 'COMPLETED' OR NOT EXISTS (
            SELECT 1 FROM fintrace.ledger_entries
             WHERE tenant_id = p_tenant_id AND transaction_id = p_transaction_id
               AND currency_id = v_currency AND debit_amount = v_amount
        ) THEN
            RAISE EXCEPTION 'Expense record is not represented by a completed ledger transaction' USING ERRCODE = '23514';
        END IF;
    END LOOP;

    FOR v_repayment_id IN
        SELECT id FROM fintrace.debt_repayments
         WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id
    LOOP
        PERFORM fintrace.validate_debt_repayment_by_id(p_tenant_id, v_repayment_id);
    END LOOP;

    FOR v_amount, v_currency IN
        SELECT amount, currency_id FROM fintrace.goal_contributions
         WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id
    LOOP
        IF v_status <> 'COMPLETED' OR NOT EXISTS (
            SELECT 1 FROM fintrace.ledger_entries
             WHERE tenant_id = p_tenant_id AND transaction_id = p_transaction_id
               AND currency_id = v_currency AND amount = v_amount
        ) THEN
            RAISE EXCEPTION 'Goal contribution is not represented by a completed ledger transaction' USING ERRCODE = '23514';
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM fintrace.investment_trades
         WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id
    ) OR EXISTS (
        SELECT 1 FROM fintrace.investment_dividends
         WHERE tenant_id = p_tenant_id AND ledger_transaction_id = p_transaction_id
    ) THEN
        IF v_status <> 'COMPLETED' THEN
            RAISE EXCEPTION 'Investment financial events require a COMPLETED ledger transaction' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1 FROM fintrace.recurring_transaction_occurrences
         WHERE tenant_id = p_tenant_id
           AND ledger_transaction_id = p_transaction_id
           AND status = 'COMPLETED'
    ) AND v_status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'Completed recurring occurrence requires a COMPLETED ledger transaction' USING ERRCODE = '23514';
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Idempotency state machine hardening
-- -----------------------------------------------------------------------------

ALTER TABLE fintrace.idempotency_operations
    ADD COLUMN failed_at TIMESTAMPTZ NULL;

ALTER TABLE fintrace.idempotency_operations
    DROP CONSTRAINT IF EXISTS idempotency_completed_ck;

ALTER TABLE fintrace.idempotency_operations
    ADD CONSTRAINT idempotency_state_ck CHECK (
        (status = 'PROCESSING'
            AND completed_at IS NULL
            AND failed_at IS NULL
            AND response_status IS NULL
            AND failure_reason = '')
        OR
        (status = 'COMPLETED'
            AND completed_at IS NOT NULL
            AND failed_at IS NULL
            AND response_status IS NOT NULL
            AND failure_reason = '')
        OR
        (status = 'FAILED'
            AND completed_at IS NULL
            AND failed_at IS NOT NULL
            AND length(btrim(failure_reason)) > 0)
        OR
        (status = 'EXPIRED'
            AND completed_at IS NULL
            AND failed_at IS NULL)
    );

-- -----------------------------------------------------------------------------
-- Global user-security audit without exposing password hashes
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fintrace.security_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID NULL,
    subject_user_id UUID NOT NULL,
    action VARCHAR(100) NOT NULL,
    before_data JSONB NULL,
    after_data JSONB NULL,
    request_id UUID NULL,
    database_user TEXT NOT NULL DEFAULT session_user,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT security_audit_actor_fk FOREIGN KEY (actor_user_id)
        REFERENCES fintrace.users(id) ON DELETE RESTRICT,
    CONSTRAINT security_audit_subject_fk FOREIGN KEY (subject_user_id)
        REFERENCES fintrace.users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS security_audit_subject_time_idx
    ON fintrace.security_audit_events(subject_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_request_idx
    ON fintrace.security_audit_events(request_id);

CREATE OR REPLACE FUNCTION fintrace.audit_user_security_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_before JSONB;
    v_after JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_before := NULL;
        v_after := (to_jsonb(NEW) - 'password_hash') || jsonb_build_object('password_changed', TRUE);
    ELSIF TG_OP = 'UPDATE' THEN
        v_before := (to_jsonb(OLD) - 'password_hash') || jsonb_build_object('password_changed', OLD.password_hash IS DISTINCT FROM NEW.password_hash);
        v_after := (to_jsonb(NEW) - 'password_hash') || jsonb_build_object('password_changed', OLD.password_hash IS DISTINCT FROM NEW.password_hash);
    ELSE
        v_before := (to_jsonb(OLD) - 'password_hash') || jsonb_build_object('password_changed', FALSE);
        v_after := NULL;
    END IF;

    INSERT INTO fintrace.security_audit_events (
        actor_user_id, subject_user_id, action, before_data, after_data, request_id, database_user
    ) VALUES (
        fintrace.current_user_id(),
        CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END,
        lower(TG_OP),
        v_before,
        v_after,
        NULLIF(current_setting('fintrace.request_id', true), '')::UUID,
        session_user
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS users_security_audit ON fintrace.users;
CREATE TRIGGER users_security_audit
AFTER INSERT OR UPDATE ON fintrace.users
FOR EACH ROW EXECUTE FUNCTION fintrace.audit_user_security_change();

CREATE TRIGGER security_audit_events_immutable_update
BEFORE UPDATE ON fintrace.security_audit_events
FOR EACH ROW EXECUTE FUNCTION fintrace.audit_immutable();
CREATE TRIGGER security_audit_events_immutable_delete
BEFORE DELETE ON fintrace.security_audit_events
FOR EACH ROW EXECUTE FUNCTION fintrace.audit_immutable();

-- -----------------------------------------------------------------------------
-- Ledger API: runtime roles should mutate ledger only through these functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.create_ledger_transaction(
    p_occurred_at TIMESTAMPTZ,
    p_reference VARCHAR DEFAULT '',
    p_description TEXT DEFAULT ''
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_tenant UUID := fintrace.current_tenant_id();
    v_id UUID;
BEGIN
    IF v_tenant IS NULL OR NOT fintrace.has_permission('transactions.create','TENANT') THEN
        RAISE EXCEPTION 'Permission transactions.create is required' USING ERRCODE = '42501';
    END IF;

    INSERT INTO fintrace.ledger_transactions (tenant_id, occurred_at, reference, description, status)
    VALUES (v_tenant, p_occurred_at, p_reference, p_description, 'PENDING')
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.add_ledger_entry(
    p_transaction_id UUID,
    p_account_id UUID,
    p_debit_amount NUMERIC(28,8) DEFAULT 0,
    p_credit_amount NUMERIC(28,8) DEFAULT 0,
    p_exchange_rate NUMERIC(28,12) DEFAULT 1
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_tenant UUID := fintrace.current_tenant_id();
    v_currency UUID;
    v_base_currency UUID;
    v_base_decimals INTEGER;
    v_amount NUMERIC(28,8);
    v_base_amount NUMERIC(28,8);
    v_id UUID;
BEGIN
    IF v_tenant IS NULL OR NOT (
        fintrace.has_permission('transactions.create','TENANT')
        OR fintrace.has_permission('transactions.update','TENANT')
    ) THEN
        RAISE EXCEPTION 'Permission to create/update transactions is required' USING ERRCODE = '42501';
    END IF;

    IF (p_debit_amount > 0 AND p_credit_amount > 0)
       OR (p_debit_amount <= 0 AND p_credit_amount <= 0) THEN
        RAISE EXCEPTION 'Exactly one of debit or credit must be positive' USING ERRCODE = '23514';
    END IF;

    SELECT a.currency_id INTO v_currency
      FROM fintrace.accounts a
     WHERE a.tenant_id = v_tenant AND a.id = p_account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Account does not exist for tenant' USING ERRCODE = '23503';
    END IF;

    SELECT t.base_currency_id, c.decimal_places
      INTO v_base_currency, v_base_decimals
      FROM fintrace.tenants t
      JOIN fintrace.currencies c ON c.id = t.base_currency_id
     WHERE t.id = v_tenant;

    v_amount := p_debit_amount + p_credit_amount;
    v_base_amount := round(v_amount * p_exchange_rate, v_base_decimals);

    INSERT INTO fintrace.ledger_entries (
        tenant_id, transaction_id, account_id, amount, debit_amount, credit_amount,
        currency_id, exchange_rate, base_amount
    ) VALUES (
        v_tenant, p_transaction_id, p_account_id, v_amount,
        p_debit_amount, p_credit_amount, v_currency, p_exchange_rate, v_base_amount
    ) RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.delete_ledger_entry(p_entry_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_tenant UUID := fintrace.current_tenant_id();
BEGIN
    IF v_tenant IS NULL OR NOT fintrace.has_permission('transactions.update','TENANT') THEN
        RAISE EXCEPTION 'Permission transactions.update is required' USING ERRCODE = '42501';
    END IF;

    DELETE FROM fintrace.ledger_entries
     WHERE tenant_id = v_tenant AND id = p_entry_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ledger entry does not exist for tenant' USING ERRCODE = '23503';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.post_ledger_transaction(p_transaction_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_tenant UUID := fintrace.current_tenant_id();
BEGIN
    IF v_tenant IS NULL OR NOT fintrace.has_permission('transactions.post','TENANT') THEN
        RAISE EXCEPTION 'Permission transactions.post is required' USING ERRCODE = '42501';
    END IF;

    PERFORM 1 FROM fintrace.ledger_transactions
     WHERE tenant_id = v_tenant AND id = p_transaction_id AND status = 'PENDING'
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Only a PENDING transaction can be posted' USING ERRCODE = '23514';
    END IF;

    UPDATE fintrace.ledger_transactions
       SET status = 'COMPLETED'
     WHERE tenant_id = v_tenant AND id = p_transaction_id;

    PERFORM fintrace.validate_completed_transaction(p_transaction_id, v_tenant);
    PERFORM fintrace.validate_transaction_metadata(p_transaction_id, v_tenant);
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.cancel_ledger_transaction(p_transaction_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_tenant UUID := fintrace.current_tenant_id();
BEGIN
    IF v_tenant IS NULL OR NOT fintrace.has_permission('transactions.update','TENANT') THEN
        RAISE EXCEPTION 'Permission transactions.update is required' USING ERRCODE = '42501';
    END IF;

    UPDATE fintrace.ledger_transactions
       SET status = 'CANCELLED'
     WHERE tenant_id = v_tenant
       AND id = p_transaction_id
       AND status = 'PENDING';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Only a PENDING transaction can be cancelled' USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.reverse_ledger_transaction(
    p_tenant_id UUID,
    p_transaction_id UUID,
    p_occurred_at TIMESTAMPTZ DEFAULT clock_timestamp(),
    p_reference VARCHAR DEFAULT ''
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_reversal_id UUID;
BEGIN
    IF fintrace.current_tenant_id() IS DISTINCT FROM p_tenant_id
       OR NOT fintrace.has_permission('transactions.reverse', 'TENANT') THEN
        RAISE EXCEPTION 'Permission transactions.reverse is required for the active tenant' USING ERRCODE = '42501';
    END IF;

    PERFORM 1 FROM fintrace.ledger_transactions
     WHERE tenant_id = p_tenant_id
       AND id = p_transaction_id
       AND status = 'COMPLETED'
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Only a COMPLETED transaction may be reversed' USING ERRCODE = '23514';
    END IF;

    INSERT INTO fintrace.ledger_transactions (
        tenant_id, occurred_at, reference, description, status, reverses_transaction_id
    ) VALUES (
        p_tenant_id, p_occurred_at, p_reference,
        'Reversal of transaction ' || p_transaction_id, 'PENDING', p_transaction_id
    ) RETURNING id INTO v_reversal_id;

    INSERT INTO fintrace.ledger_entries (
        tenant_id, transaction_id, account_id, amount,
        debit_amount, credit_amount, currency_id, exchange_rate, base_amount
    )
    SELECT tenant_id, v_reversal_id, account_id, amount,
           credit_amount, debit_amount, currency_id, exchange_rate, base_amount
      FROM fintrace.ledger_entries
     WHERE tenant_id = p_tenant_id
       AND transaction_id = p_transaction_id
     ORDER BY created_at, id;

    UPDATE fintrace.ledger_transactions
       SET status = 'COMPLETED'
     WHERE tenant_id = p_tenant_id AND id = v_reversal_id;

    PERFORM fintrace.validate_completed_transaction(v_reversal_id, p_tenant_id);
    RETURN v_reversal_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Security-invoker tenant views
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW fintrace.account_balances
WITH (security_invoker = true) AS
SELECT
    a.id AS account_id,
    a.tenant_id,
    a.name,
    a.type,
    a.normal_balance,
    a.currency_id,
    COALESCE(SUM(
        CASE WHEN a.normal_balance = 'DEBIT'
             THEN le.debit_amount - le.credit_amount
             ELSE le.credit_amount - le.debit_amount END
    ) FILTER (WHERE lt.status = 'COMPLETED'), 0) AS balance_amount,
    COALESCE(SUM(
        CASE WHEN a.normal_balance = 'DEBIT'
             THEN le.base_amount * CASE WHEN le.debit_amount > 0 THEN 1 ELSE -1 END
             ELSE le.base_amount * CASE WHEN le.credit_amount > 0 THEN 1 ELSE -1 END END
    ) FILTER (WHERE lt.status = 'COMPLETED'), 0) AS balance_base_amount
FROM fintrace.accounts a
LEFT JOIN fintrace.ledger_entries le
       ON le.tenant_id = a.tenant_id AND le.account_id = a.id
LEFT JOIN fintrace.ledger_transactions lt
       ON lt.tenant_id = le.tenant_id AND lt.id = le.transaction_id
WHERE a.tenant_id = fintrace.current_tenant_id()
GROUP BY a.id, a.tenant_id, a.name, a.type, a.normal_balance, a.currency_id;

CREATE OR REPLACE VIEW fintrace.unbalanced_transactions
WITH (security_invoker = true) AS
SELECT
    lt.id AS transaction_id,
    lt.tenant_id,
    lt.status,
    count(le.id) AS line_count,
    COALESCE(sum(le.base_amount) FILTER (WHERE le.debit_amount > 0),0) AS total_debits,
    COALESCE(sum(le.base_amount) FILTER (WHERE le.credit_amount > 0),0) AS total_credits
FROM fintrace.ledger_transactions lt
JOIN fintrace.tenants t ON t.id = lt.tenant_id
LEFT JOIN fintrace.ledger_entries le
       ON le.tenant_id = lt.tenant_id AND le.transaction_id = lt.id
WHERE lt.status = 'COMPLETED'
  AND lt.tenant_id = fintrace.current_tenant_id()
GROUP BY lt.id, lt.tenant_id, lt.status, t.base_currency_id
HAVING count(le.id) < 2
    OR COALESCE(sum(le.base_amount) FILTER (WHERE le.debit_amount > 0),0) <= 0
    OR COALESCE(sum(le.base_amount) FILTER (WHERE le.credit_amount > 0),0) <= 0
    OR abs(COALESCE(sum(le.base_amount) FILTER (WHERE le.debit_amount > 0),0)
       - COALESCE(sum(le.base_amount) FILTER (WHERE le.credit_amount > 0),0))
       > fintrace.currency_tolerance(t.base_currency_id);

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
WHERE d.tenant_id = fintrace.current_tenant_id()
GROUP BY d.id, d.tenant_id, d.type, d.contact_id,
         d.principal_amount, d.currency_id, d.status, d.start_date, d.due_date;

CREATE OR REPLACE VIEW fintrace.goal_progress
WITH (security_invoker = true) AS
SELECT
    g.id AS goal_id,
    g.tenant_id,
    g.name,
    g.target_amount,
    g.currency_id,
    COALESCE(sum(c.amount),0) AS contributed_amount,
    GREATEST(g.target_amount - COALESCE(sum(c.amount),0), 0) AS remaining_amount,
    CASE WHEN g.target_amount = 0 THEN 0
         ELSE LEAST((COALESCE(sum(c.amount),0) / g.target_amount) * 100, 100) END AS progress_percent,
    g.target_date,
    g.priority,
    g.status
FROM fintrace.goals g
LEFT JOIN fintrace.goal_contributions c
       ON c.tenant_id = g.tenant_id AND c.goal_id = g.id
WHERE g.tenant_id = fintrace.current_tenant_id()
GROUP BY g.id, g.tenant_id, g.name, g.target_amount,
         g.currency_id, g.target_date, g.priority, g.status;

CREATE OR REPLACE VIEW fintrace.asset_current_valuations
WITH (security_invoker = true) AS
SELECT DISTINCT ON (av.tenant_id, av.asset_id)
    av.asset_id, av.tenant_id, av.value, av.currency_id, av.valued_on, av.source
FROM fintrace.asset_valuations av
WHERE av.tenant_id = fintrace.current_tenant_id()
ORDER BY av.tenant_id, av.asset_id, av.valued_on DESC, av.created_at DESC;

CREATE OR REPLACE VIEW fintrace.investment_position_summary
WITH (security_invoker = true) AS
SELECT
    p.id AS position_id,
    p.tenant_id,
    p.portfolio_id,
    p.instrument_id,
    p.quantity,
    p.average_cost,
    i.symbol,
    i.name AS instrument_name,
    i.currency_id AS instrument_currency_id,
    p.updated_at
FROM fintrace.investment_positions p
JOIN fintrace.investment_instruments i
  ON i.id = p.instrument_id
 AND (i.tenant_id IS NULL OR i.tenant_id = p.tenant_id)
WHERE p.tenant_id = fintrace.current_tenant_id();

CREATE OR REPLACE VIEW fintrace.data_integrity_issues
WITH (security_invoker = true) AS
SELECT
    'UNBALANCED_LEDGER' AS issue_type,
    transaction_id AS entity_id,
    tenant_id,
    jsonb_build_object('line_count', line_count, 'total_debits', total_debits, 'total_credits', total_credits) AS details
FROM fintrace.unbalanced_transactions
UNION ALL
SELECT
    'NEGATIVE_DEBT_OUTSTANDING', debt_id, tenant_id,
    jsonb_build_object('outstanding_principal', outstanding_principal)
FROM fintrace.debt_balances
WHERE outstanding_principal < 0
UNION ALL
SELECT
    'PAID_DEBT_WITH_BALANCE', debt_id, tenant_id,
    jsonb_build_object('outstanding_principal', outstanding_principal)
FROM fintrace.debt_balances
WHERE status = 'PAID' AND outstanding_principal <> 0;

CREATE OR REPLACE VIEW fintrace.tenant_users
WITH (security_barrier = true, security_invoker = false) AS
SELECT
    u.id,
    u.username,
    u.email,
    u.first_name,
    u.last_name,
    u.status,
    u.last_login_at,
    m.tenant_id,
    m.status AS membership_status,
    m.joined_at
FROM fintrace.tenant_memberships m
JOIN fintrace.users u ON u.id = m.user_id
WHERE m.tenant_id = fintrace.current_tenant_id()
  AND fintrace.has_permission('memberships.view');

-- -----------------------------------------------------------------------------
-- Revoke sensitive helper functions from PUBLIC. Runtime grants are installed
-- by the companion role-hardening script.
-- -----------------------------------------------------------------------------

REVOKE ALL ON TABLE fintrace.security_config FROM PUBLIC;
REVOKE ALL ON TABLE fintrace.security_audit_events FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.context_signature(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.context_is_valid() FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.set_context(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.has_permission(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.currency_quantum(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.currency_tolerance(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.create_ledger_transaction(TIMESTAMPTZ, VARCHAR, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.add_ledger_entry(UUID, UUID, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.delete_ledger_entry(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.post_ledger_transaction(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.cancel_ledger_transaction(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.reverse_ledger_transaction(UUID, UUID, TIMESTAMPTZ, VARCHAR) FROM PUBLIC;


-- -----------------------------------------------------------------------------
-- RLS command separation: read permission must never imply write permission.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_memberships_isolation ON fintrace.tenant_memberships;
CREATE POLICY tenant_memberships_select ON fintrace.tenant_memberships
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('memberships.view'));
CREATE POLICY tenant_memberships_insert ON fintrace.tenant_memberships
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('memberships.create'));
CREATE POLICY tenant_memberships_update ON fintrace.tenant_memberships
    FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('memberships.update'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('memberships.update'));

DROP POLICY IF EXISTS idempotency_isolation ON fintrace.idempotency_operations;
CREATE POLICY idempotency_select ON fintrace.idempotency_operations
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id());
CREATE POLICY idempotency_insert ON fintrace.idempotency_operations
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id());
CREATE POLICY idempotency_update ON fintrace.idempotency_operations
    FOR UPDATE USING (tenant_id = fintrace.current_tenant_id())
    WITH CHECK (tenant_id = fintrace.current_tenant_id());

DROP POLICY IF EXISTS audit_isolation ON fintrace.audit_events;
CREATE POLICY audit_select ON fintrace.audit_events
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('audit.view'));

DROP POLICY IF EXISTS income_tags_isolation ON fintrace.income_tags;
CREATE POLICY income_tags_select ON fintrace.income_tags
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('income.view'));
CREATE POLICY income_tags_insert ON fintrace.income_tags
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND (fintrace.has_permission('income.create') OR fintrace.has_permission('income.update')));
CREATE POLICY income_tags_delete ON fintrace.income_tags
    FOR DELETE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('income.update'));

DROP POLICY IF EXISTS expense_tags_isolation ON fintrace.expense_tags;
CREATE POLICY expense_tags_select ON fintrace.expense_tags
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('expenses.view'));
CREATE POLICY expense_tags_insert ON fintrace.expense_tags
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND (fintrace.has_permission('expenses.create') OR fintrace.has_permission('expenses.update')));
CREATE POLICY expense_tags_delete ON fintrace.expense_tags
    FOR DELETE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('expenses.update'));

DROP POLICY IF EXISTS debt_repayments_isolation ON fintrace.debt_repayments;
CREATE POLICY debt_repayments_select ON fintrace.debt_repayments
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('debts.view'));
CREATE POLICY debt_repayments_insert ON fintrace.debt_repayments
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('debts.update'));

DROP POLICY IF EXISTS investment_portfolios_isolation ON fintrace.investment_portfolios;
CREATE POLICY investment_portfolios_select ON fintrace.investment_portfolios
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.view'));
CREATE POLICY investment_portfolios_insert ON fintrace.investment_portfolios
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.create'));
CREATE POLICY investment_portfolios_update ON fintrace.investment_portfolios
    FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.update'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.update'));

DROP POLICY IF EXISTS investment_instruments_isolation ON fintrace.investment_instruments;
CREATE POLICY investment_instruments_select ON fintrace.investment_instruments
    FOR SELECT USING ((tenant_id IS NULL OR tenant_id = fintrace.current_tenant_id()) AND fintrace.has_permission('investments.view'));
CREATE POLICY investment_instruments_insert ON fintrace.investment_instruments
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.create'));
CREATE POLICY investment_instruments_update ON fintrace.investment_instruments
    FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.update'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.update'));

DROP POLICY IF EXISTS investment_positions_isolation ON fintrace.investment_positions;
CREATE POLICY investment_positions_select ON fintrace.investment_positions
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.view'));

DROP POLICY IF EXISTS investment_trades_isolation ON fintrace.investment_trades;
CREATE POLICY investment_trades_select ON fintrace.investment_trades
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.view'));
CREATE POLICY investment_trades_insert ON fintrace.investment_trades
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.create'));

DROP POLICY IF EXISTS investment_dividends_isolation ON fintrace.investment_dividends;
CREATE POLICY investment_dividends_select ON fintrace.investment_dividends
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.view'));
CREATE POLICY investment_dividends_insert ON fintrace.investment_dividends
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('investments.create'));

DROP POLICY IF EXISTS asset_valuations_isolation ON fintrace.asset_valuations;
CREATE POLICY asset_valuations_select ON fintrace.asset_valuations
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('assets.view'));
CREATE POLICY asset_valuations_insert ON fintrace.asset_valuations
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('assets.update'));

DROP POLICY IF EXISTS goal_contributions_isolation ON fintrace.goal_contributions;
CREATE POLICY goal_contributions_select ON fintrace.goal_contributions
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('goals.view'));
CREATE POLICY goal_contributions_insert ON fintrace.goal_contributions
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('goals.update'));

DROP POLICY IF EXISTS recurring_occurrences_isolation ON fintrace.recurring_transaction_occurrences;
CREATE POLICY recurring_occurrences_select ON fintrace.recurring_transaction_occurrences
    FOR SELECT USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('recurring.view'));
CREATE POLICY recurring_occurrences_insert ON fintrace.recurring_transaction_occurrences
    FOR INSERT WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('recurring.update'));
CREATE POLICY recurring_occurrences_update ON fintrace.recurring_transaction_occurrences
    FOR UPDATE USING (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('recurring.update'))
    WITH CHECK (tenant_id = fintrace.current_tenant_id() AND fintrace.has_permission('recurring.update'));

DROP POLICY IF EXISTS rbac_membership_roles_isolation ON fintrace.rbac_membership_roles;
CREATE POLICY rbac_membership_roles_select ON fintrace.rbac_membership_roles
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM fintrace.tenant_memberships m
                 WHERE m.id = membership_id AND m.tenant_id = fintrace.current_tenant_id())
        AND fintrace.has_permission('memberships.view')
    );
CREATE POLICY rbac_membership_roles_insert ON fintrace.rbac_membership_roles
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM fintrace.tenant_memberships m
                 WHERE m.id = membership_id AND m.tenant_id = fintrace.current_tenant_id())
        AND fintrace.has_permission('memberships.update')
    );
CREATE POLICY rbac_membership_roles_delete ON fintrace.rbac_membership_roles
    FOR DELETE USING (
        EXISTS (SELECT 1 FROM fintrace.tenant_memberships m
                 WHERE m.id = membership_id AND m.tenant_id = fintrace.current_tenant_id())
        AND fintrace.has_permission('memberships.update')
    );

DROP POLICY IF EXISTS rbac_user_override_isolation ON fintrace.rbac_user_permission_overrides;
CREATE POLICY rbac_user_overrides_select ON fintrace.rbac_user_permission_overrides
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM fintrace.tenant_memberships m
                 WHERE m.id = membership_id AND m.tenant_id = fintrace.current_tenant_id())
        AND fintrace.has_permission('memberships.view')
    );
CREATE POLICY rbac_user_overrides_insert ON fintrace.rbac_user_permission_overrides
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM fintrace.tenant_memberships m
                 WHERE m.id = membership_id AND m.tenant_id = fintrace.current_tenant_id())
        AND fintrace.has_permission('memberships.update')
    );
CREATE POLICY rbac_user_overrides_update ON fintrace.rbac_user_permission_overrides
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM fintrace.tenant_memberships m
                 WHERE m.id = membership_id AND m.tenant_id = fintrace.current_tenant_id())
        AND fintrace.has_permission('memberships.update')
    ) WITH CHECK (
        EXISTS (SELECT 1 FROM fintrace.tenant_memberships m
                 WHERE m.id = membership_id AND m.tenant_id = fintrace.current_tenant_id())
        AND fintrace.has_permission('memberships.update')
    );
CREATE POLICY rbac_user_overrides_delete ON fintrace.rbac_user_permission_overrides
    FOR DELETE USING (
        EXISTS (SELECT 1 FROM fintrace.tenant_memberships m
                 WHERE m.id = membership_id AND m.tenant_id = fintrace.current_tenant_id())
        AND fintrace.has_permission('memberships.update')
    );

DROP POLICY IF EXISTS tenants_isolation ON fintrace.tenants;
CREATE POLICY tenants_select ON fintrace.tenants
    FOR SELECT USING (id = fintrace.current_tenant_id());
CREATE POLICY tenants_update ON fintrace.tenants
    FOR UPDATE USING (id = fintrace.current_tenant_id() AND fintrace.has_permission('settings.update'))
    WITH CHECK (id = fintrace.current_tenant_id() AND fintrace.has_permission('settings.update'));

-- Derived positions are maintained only by the trusted trade trigger.
CREATE OR REPLACE FUNCTION fintrace.apply_investment_trade_to_position()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_quantity NUMERIC(24,8) := 0;
    v_average_cost NUMERIC(28,8) := 0;
BEGIN
    PERFORM 1 FROM fintrace.investment_portfolios
     WHERE tenant_id = NEW.tenant_id AND id = NEW.portfolio_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Investment portfolio not found for tenant' USING ERRCODE = '23503';
    END IF;

    SELECT quantity, average_cost
      INTO v_quantity, v_average_cost
      FROM fintrace.investment_positions
     WHERE tenant_id = NEW.tenant_id
       AND portfolio_id = NEW.portfolio_id
       AND instrument_id = NEW.instrument_id
     FOR UPDATE;

    -- SELECT INTO nulls its targets when no row matches; a first trade in an
    -- instrument starts from an empty position, not an unknown one.
    IF NOT FOUND THEN
        v_quantity := 0;
        v_average_cost := 0;
    END IF;

    IF NEW.trade_type = 'BUY' THEN
        IF v_quantity = 0 THEN
            v_average_cost := round(((NEW.quantity * NEW.price) + NEW.fees) / NEW.quantity, 8);
        ELSE
            v_average_cost := round((v_quantity * v_average_cost + NEW.quantity * NEW.price + NEW.fees)
                                    / (v_quantity + NEW.quantity), 8);
        END IF;
        v_quantity := v_quantity + NEW.quantity;
        NEW.realized_pnl := 0;
    ELSE
        IF v_quantity < NEW.quantity THEN
            RAISE EXCEPTION 'Cannot sell % units when only % are available', NEW.quantity, v_quantity
                USING ERRCODE = '23514';
        END IF;
        NEW.realized_pnl := round((NEW.price - v_average_cost) * NEW.quantity - NEW.fees, 8);
        v_quantity := v_quantity - NEW.quantity;
        IF v_quantity = 0 THEN
            v_average_cost := 0;
        END IF;
    END IF;

    INSERT INTO fintrace.investment_positions (
        tenant_id, portfolio_id, instrument_id, quantity, average_cost
    ) VALUES (
        NEW.tenant_id, NEW.portfolio_id, NEW.instrument_id, v_quantity, v_average_cost
    )
    ON CONFLICT (tenant_id, portfolio_id, instrument_id)
    DO UPDATE SET quantity = EXCLUDED.quantity,
                  average_cost = EXCLUDED.average_cost,
                  updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

-- Tenant provisioning is the only audited bootstrap path allowed to operate
-- before a normal signed tenant context exists.
CREATE OR REPLACE FUNCTION fintrace.audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_tenant UUID;
    v_entity_id UUID;
    v_before JSONB;
    v_after JSONB;
    v_actor UUID := fintrace.current_user_id();
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_before := to_jsonb(OLD);
        v_after := NULL;
    ELSIF TG_OP = 'UPDATE' THEN
        v_before := to_jsonb(OLD);
        v_after := to_jsonb(NEW);
    ELSE
        v_before := NULL;
        v_after := to_jsonb(NEW);
    END IF;

    IF TG_TABLE_NAME = 'tenants' THEN
        v_tenant := COALESCE((v_after->>'id')::UUID, (v_before->>'id')::UUID);
        IF v_actor IS NULL AND TG_OP = 'INSERT' THEN
            v_actor := (v_after->>'owner_id')::UUID;
        END IF;
    ELSIF TG_TABLE_NAME IN ('rbac_membership_roles','rbac_user_permission_overrides') THEN
        SELECT tenant_id INTO v_tenant
          FROM fintrace.tenant_memberships
         WHERE id = COALESCE((v_after->>'membership_id')::UUID, (v_before->>'membership_id')::UUID);
    ELSIF TG_TABLE_NAME = 'rbac_role_permissions' THEN
        SELECT tenant_id INTO v_tenant
          FROM fintrace.rbac_roles
         WHERE id = COALESCE((v_after->>'role_id')::UUID, (v_before->>'role_id')::UUID);
    ELSE
        v_tenant := COALESCE((v_after->>'tenant_id')::UUID, (v_before->>'tenant_id')::UUID);
    END IF;

    IF v_actor IS NULL AND TG_OP = 'INSERT' AND TG_TABLE_NAME = 'tenant_memberships' THEN
        SELECT t.owner_id INTO v_actor
          FROM fintrace.tenants t
         WHERE t.id = NEW.tenant_id
           AND t.owner_id = NEW.user_id
           AND NEW.status = 'ACTIVE';
    END IF;

    IF v_actor IS NULL AND TG_OP = 'INSERT' AND TG_TABLE_NAME = 'rbac_membership_roles' THEN
        SELECT t.owner_id INTO v_actor
          FROM fintrace.tenant_memberships m
          JOIN fintrace.tenants t ON t.id = m.tenant_id AND t.owner_id = m.user_id
          JOIN fintrace.rbac_roles r ON r.id = NEW.role_id
         WHERE m.id = NEW.membership_id
           AND m.status = 'ACTIVE'
           AND r.tenant_id IS NULL
           AND r.code = 'ADMIN'
           AND r.is_system;
    END IF;

    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Audit trail requires an authenticated actor context'
            USING ERRCODE = '42501';
    END IF;

    v_entity_id := COALESCE((v_after->>'id')::UUID, (v_before->>'id')::UUID);

    IF v_tenant IS NOT NULL THEN
        INSERT INTO fintrace.audit_events (
            tenant_id, actor_user_id, action, entity_type, entity_id,
            request_id, before_data, after_data, metadata, ip_address, user_agent
        ) VALUES (
            v_tenant, v_actor, lower(TG_OP), TG_TABLE_NAME, v_entity_id,
            NULLIF(current_setting('fintrace.request_id', true), '')::UUID,
            v_before, v_after, jsonb_build_object('schema','fintrace'),
            NULLIF(current_setting('fintrace.client_ip', true), '')::INET,
            COALESCE(current_setting('fintrace.user_agent', true), '')
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Global idempotency pruning is a trusted worker operation, not tenant DML.
CREATE OR REPLACE PROCEDURE fintrace.prune_expired_idempotency_operations(p_batch_size INT DEFAULT 5000)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
BEGIN
    IF p_batch_size <= 0 OR p_batch_size > 50000 THEN
        RAISE EXCEPTION 'p_batch_size must be between 1 and 50000' USING ERRCODE = '22023';
    END IF;

    WITH expired AS (
        SELECT id
          FROM fintrace.idempotency_operations
         WHERE expires_at < clock_timestamp()
         ORDER BY expires_at, id
         LIMIT p_batch_size
         FOR UPDATE SKIP LOCKED
    )
    DELETE FROM fintrace.idempotency_operations i
     USING expired e
     WHERE i.id = e.id;
END;
$$;

REVOKE ALL ON FUNCTION fintrace.current_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION fintrace.current_user_id() FROM PUBLIC;
REVOKE ALL ON PROCEDURE fintrace.prune_expired_idempotency_operations(INT) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Shared trigger correctness fixes
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fintrace.trg_validate_completed_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_TABLE_NAME = 'ledger_transactions' THEN
        IF TG_OP <> 'DELETE' THEN
            PERFORM fintrace.validate_completed_transaction(NEW.id, NEW.tenant_id);
            RETURN NEW;
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'DELETE' THEN
        PERFORM fintrace.validate_completed_transaction(OLD.transaction_id, OLD.tenant_id);
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND (
        OLD.transaction_id IS DISTINCT FROM NEW.transaction_id
        OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    ) THEN
        PERFORM fintrace.validate_completed_transaction(OLD.transaction_id, OLD.tenant_id);
    END IF;

    PERFORM fintrace.validate_completed_transaction(NEW.transaction_id, NEW.tenant_id);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.trg_validate_debt_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_TABLE_NAME = 'debts' THEN
        IF TG_OP <> 'DELETE' THEN
            PERFORM fintrace.validate_debt_status(NEW.id, NEW.tenant_id);
            RETURN NEW;
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'DELETE' THEN
        PERFORM fintrace.validate_debt_status(OLD.debt_id, OLD.tenant_id);
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND (
        OLD.debt_id IS DISTINCT FROM NEW.debt_id
        OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    ) THEN
        PERFORM fintrace.validate_debt_status(OLD.debt_id, OLD.tenant_id);
    END IF;

    PERFORM fintrace.validate_debt_status(NEW.debt_id, NEW.tenant_id);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fintrace.update_draft_ledger_transaction(
    p_transaction_id UUID,
    p_occurred_at TIMESTAMPTZ,
    p_reference VARCHAR,
    p_description TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_tenant UUID := fintrace.current_tenant_id();
BEGIN
    IF v_tenant IS NULL OR NOT fintrace.has_permission('transactions.update','TENANT') THEN
        RAISE EXCEPTION 'Permission transactions.update is required' USING ERRCODE = '42501';
    END IF;

    UPDATE fintrace.ledger_transactions
       SET occurred_at = p_occurred_at,
           reference = COALESCE(p_reference, ''),
           description = COALESCE(p_description, '')
     WHERE tenant_id = v_tenant
       AND id = p_transaction_id
       AND status = 'PENDING';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Only a PENDING transaction can be edited' USING ERRCODE = '23514';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION fintrace.update_draft_ledger_transaction(UUID, TIMESTAMPTZ, VARCHAR, TEXT) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Workspace discovery before a tenant context exists
-- -----------------------------------------------------------------------------
-- tenants and tenant_memberships are only visible inside a signed tenant
-- context, but sign-in has to learn which workspaces a user may enter before one
-- can be set. This returns only the caller-supplied user's own ACTIVE
-- memberships of ACTIVE tenants. With p_platform_admin it also lists the other
-- active workspaces (name and slug only, is_member = FALSE) so a platform
-- administrator can see they exist; fintrace.set_context() still refuses to
-- enter any workspace without an active membership.
CREATE OR REPLACE FUNCTION fintrace.list_user_tenants(
    p_user_id UUID,
    p_platform_admin BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    id UUID, slug VARCHAR, name VARCHAR, status VARCHAR, is_member BOOLEAN,
    base_currency_id UUID, base_currency_code VARCHAR, base_currency_symbol VARCHAR, base_currency_decimals SMALLINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
    SELECT t.id, t.slug, t.name, t.status, (m.id IS NOT NULL) AS is_member,
           c.id, c.code, c.symbol, c.decimal_places
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

-- -----------------------------------------------------------------------------
-- Row-level security: evaluate the permission once per statement, not per row
-- -----------------------------------------------------------------------------
-- A policy that calls fintrace.has_permission(...) directly runs it for every
-- candidate row. Wrapping the call in a scalar sub-select makes PostgreSQL
-- compute it once per statement (an InitPlan) and reuse the result. The check
-- itself is unchanged: same function, same arguments, same STABLE snapshot.
DO $$
DECLARE
    p RECORD;
    v_using TEXT;
    v_check TEXT;
    v_sql TEXT;
BEGIN
    FOR p IN
        SELECT schemaname, tablename, policyname, qual, with_check
          FROM pg_policies
         WHERE schemaname = 'fintrace'
           AND (qual ~ 'has_permission\(' OR with_check ~ 'has_permission\(')
    LOOP
        -- Already wrapped (this block is safe to run again).
        CONTINUE WHEN COALESCE(p.qual, '') ~ 'SELECT (fintrace\.)?has_permission\('
                   OR COALESCE(p.with_check, '') ~ 'SELECT (fintrace\.)?has_permission\(';

        v_using := regexp_replace(p.qual, '(fintrace\.)?has_permission\(([^()]*)\)', '(SELECT fintrace.has_permission(\2))', 'g');
        v_check := regexp_replace(p.with_check, '(fintrace\.)?has_permission\(([^()]*)\)', '(SELECT fintrace.has_permission(\2))', 'g');

        v_sql := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
        IF v_using IS NOT NULL THEN
            v_sql := v_sql || format(' USING (%s)', v_using);
        END IF;
        IF v_check IS NOT NULL THEN
            v_sql := v_sql || format(' WITH CHECK (%s)', v_check);
        END IF;
        EXECUTE v_sql;
    END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- Broker connections (Zerodha Kite / Coin): read-only portfolio snapshots
-- -----------------------------------------------------------------------------
-- What a broker reports is kept apart from the ledger: it is the broker's view of
-- holdings at market prices, refreshed on demand, and never posts ledger entries.
CREATE TABLE IF NOT EXISTS fintrace.broker_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    provider VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'CONNECTED',
    broker_user_id VARCHAR(50) NOT NULL DEFAULT '',
    broker_user_name VARCHAR(255) NOT NULL DEFAULT '',
    -- Encrypted by the application; never returned by the API.
    access_token_encrypted TEXT NULL,
    token_expires_at TIMESTAMPTZ NULL,
    connected_by UUID NOT NULL,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_synced_at TIMESTAMPTZ NULL,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT broker_connections_tenant_id_uk UNIQUE (tenant_id, id),
    CONSTRAINT broker_connections_tenant_provider_uk UNIQUE (tenant_id, provider),
    CONSTRAINT broker_connections_tenant_fk FOREIGN KEY (tenant_id) REFERENCES fintrace.tenants(id) ON DELETE RESTRICT,
    CONSTRAINT broker_connections_user_fk FOREIGN KEY (connected_by) REFERENCES fintrace.users(id) ON DELETE RESTRICT,
    CONSTRAINT broker_connections_provider_ck CHECK (provider IN ('ZERODHA')),
    CONSTRAINT broker_connections_status_ck CHECK (status IN ('CONNECTED','EXPIRED','DISCONNECTED','SAMPLE')),
    CONSTRAINT broker_connections_token_ck CHECK (status = 'CONNECTED' OR access_token_encrypted IS NULL)
);

CREATE TABLE IF NOT EXISTS fintrace.broker_holdings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    asset_class VARCHAR(20) NOT NULL,
    symbol VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL DEFAULT '',
    exchange VARCHAR(20) NOT NULL DEFAULT '',
    isin VARCHAR(20) NOT NULL DEFAULT '',
    folio VARCHAR(50) NOT NULL DEFAULT '',
    quantity NUMERIC(24,6) NOT NULL,
    average_price NUMERIC(19,6) NOT NULL,
    last_price NUMERIC(19,6) NOT NULL,
    close_price NUMERIC(19,6) NULL,
    invested_value NUMERIC(19,2) NOT NULL,
    current_value NUMERIC(19,2) NOT NULL,
    pnl NUMERIC(19,2) NOT NULL,
    day_change NUMERIC(19,2) NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT broker_holdings_connection_fk FOREIGN KEY (tenant_id, connection_id)
        REFERENCES fintrace.broker_connections(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT broker_holdings_class_ck CHECK (asset_class IN ('EQUITY','MUTUAL_FUND')),
    CONSTRAINT broker_holdings_quantity_ck CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS broker_holdings_connection_idx
    ON fintrace.broker_holdings(tenant_id, connection_id, asset_class);

CREATE TABLE IF NOT EXISTS fintrace.broker_portfolio_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    snapshot_date DATE NOT NULL,
    invested_value NUMERIC(19,2) NOT NULL,
    current_value NUMERIC(19,2) NOT NULL,
    equity_value NUMERIC(19,2) NOT NULL DEFAULT 0,
    mutual_fund_value NUMERIC(19,2) NOT NULL DEFAULT 0,
    holding_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT broker_snapshots_connection_fk FOREIGN KEY (tenant_id, connection_id)
        REFERENCES fintrace.broker_connections(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT broker_snapshots_day_uk UNIQUE (tenant_id, connection_id, snapshot_date)
);

DROP TRIGGER IF EXISTS broker_connections_updated_at ON fintrace.broker_connections;
CREATE TRIGGER broker_connections_updated_at BEFORE UPDATE ON fintrace.broker_connections
FOR EACH ROW EXECUTE FUNCTION fintrace.set_updated_at();

ALTER TABLE fintrace.broker_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.broker_holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fintrace.broker_portfolio_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['broker_connections','broker_holdings','broker_portfolio_snapshots'] LOOP
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
