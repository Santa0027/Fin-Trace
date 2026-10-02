# Schema Fixes

## 1. enforce_category_type trigger signature
- **Problem**: Schema bootstrap failed on trigger creation.
- **Root cause**: The `fintrace.enforce_category_type(p_expected TEXT)` function was defined with an argument, but PostgreSQL requires trigger functions to have 0 parameters.
- **Fix**: Removed the parameter and replaced it with `TG_ARGV[0]`.
- **Regression validation**: `fintrace_bootstrap_check` successfully initializes without manual intervention.

## 2. debt trigger / DDL ordering
- **Problem**: `ALTER TABLE fintrace.debts ALTER COLUMN principal_amount TYPE NUMERIC(28,8)` failed because of a dependent trigger.
- **Root cause**: PostgreSQL blocks altering a column type if a trigger depends on it directly.
- **Fix**: Added a `DROP TRIGGER` before the `ALTER TABLE` and a `CREATE TRIGGER` immediately after it.
- **Regression validation**: The database successfully bootstraps completely from scratch.

## 3. provision_tenant RAISE syntax
- **Problem**: `RAISE EXCEPTION` in `provision_tenant` crashed on tenant creation.
- **Root cause**: The string `'Active user % is required...'` contained a formatting token `%` but no parameter was provided in the `USING` clause.
- **Fix**: Appended `, p_user_id` before the `USING ERRCODE` clause.
- **Regression validation**: Tests can securely call `fintrace.provision_tenant()` without syntax errors.

## 4. context_signature public.hmac qualification
- **Problem**: Integration tests calling `fintrace.set_context` threw a `function hmac(bytea, bytea, unknown) does not exist` error.
- **Root cause**: `fintrace.set_context` calls `context_signature` which is `SECURITY DEFINER` with `SET search_path = fintrace, pg_temp`. It could not resolve the `pgcrypto` function in `public`.
- **Fix**: Qualified `hmac` as `public.hmac` rather than weakening the secure `search_path`.
- **Regression validation**: `test_tenant_isolation` integration tests run successfully, proving `hmac` resolves safely.

## 5. narrowed check_function_bodies scope
- **Problem**: `SET check_function_bodies = off;` was used globally across the entire schema as a band-aid.
- **Root cause**: The `fintrace.has_permission` function forward-references RBAC tables that aren't defined until later in the file.
- **Fix**: Removed the global `SET` and instead narrowly wrapped the `has_permission` function declaration in `SET LOCAL check_function_bodies = off;` / `on;`.
- **Regression validation**: A fresh DB bootstrap parses the entire schema safely, validating all other function bodies normally.

## 6. income validation RAISE formatting correction
- **Problem**: `validate_transaction_metadata` caused a syntax compilation error during bootstrap.
- **Root cause**: `RAISE EXCEPTION 'Income record % is not represented...' USING ...` was missing the expected format variable for the `%`.
- **Fix**: Removed the `%` formatting token to match the provided arguments.
- **Regression validation**: The function compiles cleanly during the `schema.sql` execution.
