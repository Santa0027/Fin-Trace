# Production Readiness Checklist

Enforced by the code (the app refuses to start, or the bootstrap fails, otherwise):

- [x] `ENV=production` requires `DEBUG=False` and a non-placeholder `SECRET_KEY`
- [x] Secure, HttpOnly, SameSite=Lax session cookie; secure CSRF cookie; HSTS; SSL redirect (with `ENV=production`)
- [x] Runtime database role is not a superuser, does not own the schema and cannot bypass RLS (verified by `scripts/bootstrap_db.py`)
- [x] Runtime role cannot read the tenant-context signing secret or rewrite audit rows
- [x] No tenant or user id is accepted from request headers or bodies; the workspace comes from the session and is re-checked against membership on every request
- [x] Failed sign-ins are throttled through a cache shared by all workers (database cache when `ENV=production`)
- [x] Money-changing endpoints require an idempotency key; claim, posting and response commit atomically
- [x] No mock data in the frontend; production build passes
- [x] Health checks: `/api/health/live/`, `/api/health/ready/`

To do per deployment:

- [ ] TLS terminated in front of the app, with `X-Forwarded-Proto` set by the proxy
- [ ] Frontend and `/api` served from the same origin; `CSRF_TRUSTED_ORIGINS` and `ALLOWED_HOSTS` set to it
- [ ] `python manage.py validate_runtime_database --strict` passes
- [ ] Backend integration tests and frontend tests pass in CI (`.github/workflows/ci.yml`)
- [ ] Backups scheduled and a restore rehearsed (`docs/backup-restore.md`)
- [ ] `process_recurring_transactions` scheduled per workspace, if recurring items should post automatically
- [ ] `prune_idempotency_operations` scheduled (daily)
- [ ] Sessions pruned: `python manage.py clearsessions` (daily)
- [ ] If the Zerodha connection is used: `KITE_API_KEY`, `KITE_API_SECRET` and a dedicated `FINTRACE_TOKEN_ENCRYPTION_KEY` set; redirect URL registered with Zerodha
- [ ] Log shipping and error alerting configured for the `FinTrace` logger

Known limits (by design, not defects):

- Investments are carried at cost; there is no market price feed.
- An investment trade is corrected with the opposite trade, not a reversal.
- New accounts for people without one are created by a workspace administrator with a temporary password; there is no self-service sign-up or email delivery.
