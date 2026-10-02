# Runtime Security

## SECURITY DEFINER Audit

| Function | Purpose | Search Path | External Functions | Qualified | Status |
|----------|---------|-------------|--------------------|-----------|--------|
| `fintrace.provision_tenant` | Provisions a new tenant | `fintrace, pg_temp` | None | N/A | Safe |
| `fintrace.set_context` | Sets execution context | `fintrace, pg_temp` | `hmac` | Yes (`public.hmac`) | Safe |
| `fintrace.context_signature` | Generates HMAC signature | `fintrace, pg_temp` | `hmac` | Yes (`public.hmac`) | Safe |
| `fintrace.current_tenant_id` | Gets current tenant | `fintrace, pg_temp` | None | N/A | Safe |
| `fintrace.current_user_id` | Gets current user | `fintrace, pg_temp` | None | N/A | Safe |

Note: `gen_random_uuid()` is safely located in `pg_catalog` and automatically resolved. `gen_random_bytes` is used in schema insert context only, avoiding restriction paths. `hmac` from `pgcrypto` in `public` is properly qualified.
