# Schema Coverage

Generated from `schema.sql` and current application code. A Django model alone does not mean implemented.

| SQL Object | Type | Django Model | Repository | Service | API | Internal Only | Status |
|---|---|---:|---|---|---|---:|---|
| `currencies` | table | yes | DjangoCurrencyRepository | CurrencyService | read-only currency list | no | IMPLEMENTED |
| `users` | table | yes | ReportingRepository via tenant_users | ReportingService | safe tenant user reporting only; no password hash exposure | no | IMPLEMENTED |
| `tenants` | table | yes | TenantResourceRepository | TenantService | business resource endpoint | no | IMPLEMENTED |
| `rbac_pages` | table | yes | RBACRepository | RBACService | read-only RBAC management endpoint | no | IMPLEMENTED |
| `rbac_actions` | table | yes | RBACRepository | RBACService | read-only RBAC management endpoint | no | IMPLEMENTED |
| `rbac_permissions` | table | yes | RBACRepository | RBACService | read-only RBAC management endpoint | no | IMPLEMENTED |
| `rbac_roles` | table | yes | RBACRepository | RBACService | tenant role create/read endpoint | no | IMPLEMENTED |
| `tenant_memberships` | table | yes | TenantResourceRepository | MembershipService | business resource endpoint | no | IMPLEMENTED |
| `rbac_role_permissions` | table | yes | RBACRepository | RBACService | controlled assign/remove endpoint | yes | IMPLEMENTED |
| `rbac_membership_roles` | table | yes | RBACRepository | RBACService | controlled assign/remove endpoint | yes | IMPLEMENTED |
| `rbac_user_permission_overrides` | table | yes | RBACRepository | RBACService | controlled override endpoint | yes | IMPLEMENTED |
| `idempotency_operations` | table | yes | IdempotencyRepository | IdempotencyService | financial POST guard and prune command; no generic CRUD | yes | IMPLEMENTED |
| `audit_events` | table | yes | AuditRepository | AuditService | read/query endpoint; no mutation API | yes | IMPLEMENTED |
| `categories` | table | yes | TenantResourceRepository | CategoryService | business resource endpoint | no | IMPLEMENTED |
| `tags` | table | yes | TenantResourceRepository | ResourceService | business resource endpoint | no | IMPLEMENTED |
| `contacts` | table | yes | TenantResourceRepository | ContactService | business resource endpoint | no | IMPLEMENTED |
| `accounts` | table | yes | TenantResourceRepository | AccountService | business resource endpoint | no | IMPLEMENTED |
| `ledger_transactions` | table | yes | PostgreSQLLedgerRepository | LedgerService | controlled workflow endpoint/service | no | IMPLEMENTED |
| `ledger_entries` | table | yes | PostgreSQLLedgerRepository | LedgerService | controlled workflow endpoint/service | no | IMPLEMENTED |
| `income_records` | table | yes | PostgreSQLFinancialMetadataRepository | IncomeService | controlled workflow endpoint/service | no | IMPLEMENTED |
| `income_tags` | table | yes | TagAssociationRepository | TagService | controlled attach/detach endpoints | yes | IMPLEMENTED |
| `expense_records` | table | yes | PostgreSQLFinancialMetadataRepository | ExpenseService | controlled workflow endpoint/service | no | IMPLEMENTED |
| `expense_tags` | table | yes | TagAssociationRepository | TagService | controlled attach/detach endpoints | yes | IMPLEMENTED |
| `debts` | table | yes | TenantResourceRepository | ResourceService | business resource endpoint | no | IMPLEMENTED |
| `debt_repayments` | table | yes | PostgreSQLFinancialMetadataRepository | DebtService | controlled workflow endpoint/service | no | IMPLEMENTED |
| `investment_portfolios` | table | yes | TenantResourceRepository | ResourceService | business resource endpoint | no | IMPLEMENTED |
| `investment_instruments` | table | yes | TenantResourceRepository | ResourceService | business resource endpoint | no | IMPLEMENTED |
| `investment_positions` | table | yes | ReportingRepository | ReportingService | read-only via reports | no | IMPLEMENTED |
| `investment_trades` | table | yes | InvestmentRepository | InvestmentService | controlled workflow endpoint/service | no | IMPLEMENTED |
| `investment_dividends` | table | yes | InvestmentRepository | InvestmentService | controlled workflow endpoint/service | no | IMPLEMENTED |
| `assets` | table | yes | TenantResourceRepository | ResourceService | business resource endpoint | no | IMPLEMENTED |
| `asset_valuations` | table | yes | HistoryRepository | AssetService | controlled workflow endpoint/service | no | IMPLEMENTED |
| `goals` | table | yes | TenantResourceRepository | ResourceService | business resource endpoint | no | IMPLEMENTED |
| `goal_contributions` | table | yes | HistoryRepository | GoalService | controlled workflow endpoint/service | no | IMPLEMENTED |
| `subscriptions` | table | yes | TenantResourceRepository | SubscriptionService | business resource endpoint | no | IMPLEMENTED |
| `recurring_transactions` | table | yes | TenantResourceRepository | ResourceService | business resource endpoint | no | IMPLEMENTED |
| `recurring_transaction_occurrences` | table | yes | RecurringRepository | RecurringService | read/query plus locked execution command; no generic CRUD | yes | IMPLEMENTED |
| `security_config` | table | yes | AuditRepository | AuditService | safe status only; secret never exposed | yes | INTERNAL_ONLY |
| `security_audit_events` | table | yes | AuditRepository | AuditService | read/query endpoint; no mutation API | yes | IMPLEMENTED |
| `account_balances` | view | yes | ReportingRepository | ReportingService | read-only `/api/v1/reports/account-balances/` | no | IMPLEMENTED |
| `unbalanced_transactions` | view | yes | ReportingRepository | ReportingService | read-only `/api/v1/reports/unbalanced-transactions/` | no | IMPLEMENTED |
| `debt_balances` | view | yes | ReportingRepository | ReportingService | read-only `/api/v1/reports/debt-balances/` | no | IMPLEMENTED |
| `goal_progress` | view | yes | ReportingRepository | ReportingService | read-only `/api/v1/reports/goal-progress/` | no | IMPLEMENTED |
| `asset_current_valuations` | view | yes | ReportingRepository | ReportingService | read-only `/api/v1/reports/asset-current-valuations/` | no | IMPLEMENTED |
| `investment_position_summary` | view | yes | ReportingRepository | ReportingService | read-only `/api/v1/reports/investment-position-summary/` | no | IMPLEMENTED |
| `data_integrity_issues` | view | yes | ReportingRepository | ReportingService | read-only `/api/v1/reports/data-integrity-issues/` | no | IMPLEMENTED |
| `tenant_users` | view | yes | ReportingRepository | ReportingService | read-only `/api/v1/reports/tenant-users/` | no | IMPLEMENTED |

## Trigger-Controlled Workflows

| Workflow | Database objects | Python entry point | Status |
|---|---|---|---|
| Tenant/user context and RLS | `set_context, current_tenant_id, current_user_id, RLS policies` | tenant_transaction | IMPLEMENTED |
| Ledger mutation | `create/add/delete/post/cancel/reverse ledger functions and ledger triggers` | LedgerService/PostgreSQLLedgerRepository | IMPLEMENTED |
| Income/expense reconciliation | `income/expense ledger link constraint triggers` | IncomeService/ExpenseService | IMPLEMENTED |
| Debt repayment reconciliation | `debt repayment validation triggers` | DebtService | IMPLEMENTED |
| Investment reconciliation and derived positions | `investment trade/dividend validation and position trigger` | InvestmentService | IMPLEMENTED |
| Append-only audit | `audit_row_change, audit_immutable triggers` | AuditService read-only | IMPLEMENTED |
| Recurring occurrence locking/execution | `FOR UPDATE SKIP LOCKED query against occurrences` | RecurringService/process_recurring_transactions | IMPLEMENTED |
| Idempotency lifecycle | `idempotency_operations constraints` | IdempotencyService | IMPLEMENTED |

## Coverage Summary

- Tables: 39 total, 38 implemented, 1 internal-only, 0 partial, 0 missing.
- Views: 8 total, 8 implemented, 0 missing.
- `users` is intentionally exposed only through the safe `tenant_users` reporting view; `password_hash` is not surfaced by API code.
- `security_config` is intentionally deployment/internal configuration. The API returns only `singleton`, `created_at`, and `has_context_hmac_secret`.
- Recurring execution is implemented for schema-supported transfers. Recurring income/expense definitions still need explicit counterpart-account product/schema fields before they can be executed without ambiguity; those occurrences fail closed with a recorded reason.
