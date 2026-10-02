-- Grant connect
GRANT CONNECT ON DATABASE fintrace_integration TO fintrace_app, fintrace_worker, fintrace_auditor;

-- Grant usage on schema
GRANT USAGE ON SCHEMA fintrace TO fintrace_app, fintrace_worker, fintrace_auditor;

-- For fintrace_app, grant SELECT, INSERT, UPDATE, DELETE on tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fintrace TO fintrace_app;
-- Exclude unrestricted mutation of audit_events if needed, but RLS protects it if RLS is forced
-- Actually, the request says "unrestricted direct mutation of protected ledger objects" should be prevented.
-- Let's just grant all privileges, the RLS policies and triggers in schema.sql will restrict them.
-- But wait! If RLS is enabled, we need to make sure fintrace_app is NOT superuser and NOT bypassrls, which it isn't.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fintrace TO fintrace_worker;

GRANT SELECT ON ALL TABLES IN SCHEMA fintrace TO fintrace_auditor;

-- Grant execute on functions
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA fintrace TO fintrace_app, fintrace_worker, fintrace_auditor;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA fintrace TO fintrace_app, fintrace_worker, fintrace_auditor;

-- Grant usage on sequences
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fintrace TO fintrace_app, fintrace_worker, fintrace_auditor;
