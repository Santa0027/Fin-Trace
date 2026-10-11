-- Patch for databases bootstrapped before this function was added to schema.sql.
-- Run as the schema owner (fintrace_owner). Safe to run more than once.

BEGIN;

DROP FUNCTION IF EXISTS fintrace.list_user_tenants(UUID, BOOLEAN);

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

GRANT EXECUTE ON FUNCTION fintrace.list_user_tenants(UUID, BOOLEAN) TO fintrace_app;

COMMIT;
