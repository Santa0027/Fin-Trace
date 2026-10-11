-- Patch for databases bootstrapped before this was added to schema.sql.
-- Run as the schema owner (fintrace_owner). Safe to run more than once.

BEGIN;

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

COMMIT;
