-- Patch for databases bootstrapped before this was added to schema.sql.
-- Run as the schema owner (fintrace_owner). Safe to run more than once.

BEGIN;

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

COMMIT;
