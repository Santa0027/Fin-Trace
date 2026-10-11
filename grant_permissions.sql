-- Runtime privileges for the FinTrace roles. Run against the FinTrace database
-- as a superuser or the schema owner, after schema.sql (and after any patch or
-- Django migration that creates tables). scripts/bootstrap_db.py does this for you.
--
-- Row-level security and the posting routines are what restrict these roles;
-- none of them is a superuser, owns the schema, or can bypass RLS.

DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO fintrace_app, fintrace_worker, fintrace_auditor', current_database());
END;
$$;

GRANT USAGE ON SCHEMA fintrace TO fintrace_app, fintrace_worker, fintrace_auditor;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fintrace TO fintrace_app, fintrace_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA fintrace TO fintrace_auditor;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA fintrace TO fintrace_app, fintrace_worker, fintrace_auditor;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA fintrace TO fintrace_app, fintrace_worker, fintrace_auditor;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fintrace TO fintrace_app, fintrace_worker, fintrace_auditor;

-- The blanket grants above must not reach the secret that signs the tenant
-- context. A runtime role that can read it (or call the signer directly) could
-- forge a context for a tenant the user does not belong to, bypassing the
-- membership check in fintrace.set_context(). Only non-secret columns stay readable.
REVOKE ALL ON TABLE fintrace.security_config FROM fintrace_app, fintrace_worker, fintrace_auditor;
GRANT SELECT (singleton, created_at) ON TABLE fintrace.security_config TO fintrace_app, fintrace_auditor;
REVOKE EXECUTE ON FUNCTION fintrace.context_signature(UUID, UUID) FROM fintrace_app, fintrace_worker, fintrace_auditor;

-- Audit trails are append-only for every runtime role.
REVOKE UPDATE, DELETE ON TABLE fintrace.audit_events, fintrace.security_audit_events FROM fintrace_app, fintrace_worker;

-- Broker session tokens are encrypted, but the auditor has no business reading them at all.
DO $$
BEGIN
    IF to_regclass('fintrace.broker_connections') IS NOT NULL THEN
        REVOKE SELECT ON TABLE fintrace.broker_connections FROM fintrace_auditor;
        GRANT SELECT (id, tenant_id, provider, status, broker_user_id, broker_user_name, token_expires_at, connected_by, connected_at, last_synced_at, last_error, cash_available)
            ON TABLE fintrace.broker_connections TO fintrace_auditor;
    END IF;
END;
$$;

-- The auditor reads; it never needs session or cache contents.
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['django_session', 'django_cache'] LOOP
        IF to_regclass('fintrace.' || t) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON TABLE fintrace.%I FROM fintrace_auditor', t);
        END IF;
    END LOOP;
END;
$$;
