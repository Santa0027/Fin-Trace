# SQL Functions and Procedures

| SQL Function/Procedure | Purpose | Called by Python? | Python Repository/Service | Internal DB Only |
|---|---|---:|---|---:|
| `current_tenant_id` | tenant/RBAC context | no | database trigger/helper | yes |
| `current_user_id` | tenant/RBAC context | no | database trigger/helper | yes |
| `set_updated_at` | trigger/helper validation | no | database trigger/helper | yes |
| `assert_not_null_uuid` | trigger/helper validation | no | database trigger/helper | yes |
| `set_context` | tenant/RBAC context | yes | tenant_transaction | no |
| `has_permission` | tenant/RBAC context | no | database trigger/helper | yes |
| `reverse_ledger_transaction` | ledger API | yes | PostgreSQLLedgerRepository/LedgerService | no |
| `validate_ledger_entry` | ledger API | no | database trigger/helper | yes |
| `block_ledger_entry_delete` | ledger API | no | database trigger/helper | yes |
| `validate_reversal` | trigger/helper validation | no | database trigger/helper | yes |
| `block_terminal_ledger_update` | ledger API | no | database trigger/helper | yes |
| `validate_completed_transaction` | trigger/helper validation | no | database trigger/helper | yes |
| `trg_validate_completed_transaction` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_active_references` | trigger/helper validation | no | database trigger/helper | yes |
| `enforce_category_type` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_recurring_definition` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_goal_contribution_currency` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_asset_valuation_currency` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_subscription_accounts_currency` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_recurring_accounts_currency` | trigger/helper validation | no | database trigger/helper | yes |
| `protect_instrument_tenant_identity` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_instrument_tenant` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_income_expense_ledger_link` | ledger API | no | database trigger/helper | yes |
| `validate_debt_repayment_ledger_link` | ledger API | no | database trigger/helper | yes |
| `validate_goal_contribution_ledger_link` | ledger API | no | database trigger/helper | yes |
| `validate_transaction_metadata` | trigger/helper validation | no | database trigger/helper | yes |
| `trg_validate_transaction_metadata` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_debt_status` | trigger/helper validation | no | database trigger/helper | yes |
| `trg_validate_debt_status` | trigger/helper validation | no | database trigger/helper | yes |
| `block_investment_trade_mutation` | trigger/helper validation | no | database trigger/helper | yes |
| `apply_investment_trade_to_position` | trigger/helper validation | no | database trigger/helper | yes |
| `guard_investment_position_write` | trigger/helper validation | no | database trigger/helper | yes |
| `audit_row_change` | trigger/helper validation | no | database trigger/helper | yes |
| `audit_immutable` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_tenant_base_currency` | trigger/helper validation | no | database trigger/helper | yes |
| `block_tenant_delete` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_tenant_owner` | trigger/helper validation | no | database trigger/helper | yes |
| `trg_validate_owner_change` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_tenant_owner_for_id` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_membership_role_tenant` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_user_override_permission_tenant` | trigger/helper validation | no | database trigger/helper | yes |
| `protect_system_role` | trigger/helper validation | no | database trigger/helper | yes |
| `block_system_role_delete` | trigger/helper validation | no | database trigger/helper | yes |
| `block_business_delete` | trigger/helper validation | no | database trigger/helper | yes |
| `protect_tenant_base_currency` | trigger/helper validation | no | database trigger/helper | yes |
| `protect_account_financial_identity` | trigger/helper validation | no | database trigger/helper | yes |
| `protect_category_type_after_use` | trigger/helper validation | no | database trigger/helper | yes |
| `protect_debt_identity_after_repayment` | trigger/helper validation | no | database trigger/helper | yes |
| `block_history_update` | trigger/helper validation | no | database trigger/helper | yes |
| `provision_tenant` | tenant provisioning workflow | yes | TenantResourceRepository/TenantService | no |
| `protect_global_role_permissions` | trigger/helper validation | no | database trigger/helper | yes |
| `context_signature` | tenant/RBAC context | no | database trigger/helper | yes |
| `context_is_valid` | tenant/RBAC context | no | database trigger/helper | yes |
| `currency_quantum` | trigger/helper validation | no | database trigger/helper | yes |
| `currency_tolerance` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_investment_account_currency` | trigger/helper validation | no | database trigger/helper | yes |
| `validate_investment_trade_ledger_link` | ledger API | no | database trigger/helper | yes |
| `validate_investment_dividend_ledger_link` | ledger API | no | database trigger/helper | yes |
| `validate_debt_repayment_by_id` | trigger/helper validation | no | database trigger/helper | yes |
| `audit_user_security_change` | trigger/helper validation | no | database trigger/helper | yes |
| `create_ledger_transaction` | ledger API | yes | PostgreSQLLedgerRepository/LedgerService | no |
| `add_ledger_entry` | ledger API | yes | PostgreSQLLedgerRepository/LedgerService | no |
| `delete_ledger_entry` | ledger API | yes | PostgreSQLLedgerRepository/LedgerService | no |
| `post_ledger_transaction` | ledger API | yes | PostgreSQLLedgerRepository/LedgerService | no |
| `cancel_ledger_transaction` | ledger API | yes | PostgreSQLLedgerRepository/LedgerService | no |
| `update_draft_ledger_transaction` | ledger API | yes | PostgreSQLLedgerRepository | no |
| `prune_expired_idempotency_operations` | maintenance procedure | yes | IdempotencyRepository/IdempotencyService/prune_idempotency_operations | no |

## SQL Entry Point Summary

- Python-called SQL entry points: `set_context`, ledger create/add/delete/post/cancel/reverse/update functions, `provision_tenant`, and `prune_expired_idempotency_operations`.
- Intentionally database-internal functions include RLS context readers, permission checks, validation triggers, audit triggers, immutable/history guards, and derived investment position maintenance.
