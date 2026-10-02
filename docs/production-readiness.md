# Production Readiness Checklist

[ ] DEBUG=False
[ ] strong SECRET_KEY
[ ] TLS enabled
[ ] secure session cookie
[ ] secure CSRF cookie
[ ] correct SameSite
[ ] trusted origins configured
[ ] restricted CORS
[ ] no X-User-ID
[ ] no X-Tenant-ID
[ ] login rate limiting
[ ] runtime DB role not superuser
[ ] runtime DB role not BYPASSRLS
[ ] strict DB validation passes
[ ] tenant integration tests pass
[ ] ledger integration tests pass
[ ] idempotency tests pass
[ ] investment tests pass
[ ] audit tests pass
[ ] RBAC tests pass
[ ] frontend mock data removed
[ ] production frontend build passes
[ ] Celery uses restricted role
[ ] health checks work
[ ] backup documented/tested
[ ] migration plan reviewed
[ ] secrets absent from repository
