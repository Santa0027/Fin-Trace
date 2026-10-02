# Platform Admin Security

Normal tenant data access MUST still be compatible with:
`fintrace.set_context(user_id, tenant_id)` and PostgreSQL membership/RLS.

Final policy:
- Django superuser WITHOUT active tenant membership: may use platform-level administration but MAY NOT enter tenant financial data context.
- Django superuser WITH active tenant membership: may switch into that tenant.

If the product requires an administrator to enter a company, an explicit tenant membership must be created/activated first.
We DO NOT modify `set_context` to bypass tenant membership.
