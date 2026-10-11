# FinTrace API (v1)

Base path `/api/v1`. Session-cookie authentication; unsafe methods need the
`X-CSRFToken` header (`GET /auth/csrf/` sets the cookie). The active workspace
lives in the server session, so no request carries a tenant id. PostgreSQL
row-level security and RBAC enforce access on every statement.

## Conventions

- Lists: `{"results": [...], "limit", "offset"}` plus `"total"` where the list is filterable.
- Money: decimal strings. Never floats.
- Dates: `YYYY-MM-DD` calendar days in the workspace's timezone (`tenants.timezone`,
  changeable with `PATCH /tenants/{id}/`). A date-only entry is stored at local noon;
  period filters and reports use the workspace's local day.
- Errors: `{"error": {"code", "message", "fields": {field: message}}}` with a
  matching HTTP status (400 validation, 401 signed out, 403 not permitted,
  404 missing, 409 conflict / no active workspace, 429 throttled).
- Money-changing endpoints (marked ⟳) require an `Idempotency-Key` header. Same key
  and same body replays the original response (`Idempotent-Replayed: true`); same
  key with a different body is `409 IDEMPOTENCY_KEY_REUSED`. The key claim, the
  ledger posting and the stored response commit in one transaction.

## Endpoints

| Area | Method and path | Notes |
|------|-----------------|-------|
| Auth | `POST /auth/login/`, `POST /auth/logout/`, `GET /auth/me/`, `GET /auth/csrf/`, `POST /auth/change-password/` | Login accepts `email` or `username`; 5 failures locks that identifier for 15 minutes. |
| Workspaces | `GET /auth/companies/`, `POST /auth/switch-tenant/` | Only workspaces the user is an active member of can be entered. |
| Permissions | `GET /rbac/effective-permissions/` | |
| Accounts | `GET/POST /accounts/`, `GET/PATCH /accounts/{id}/`, `POST /accounts/{id}/archive/` | Rows include `balance_amount`, `category` and `is_payment_account`. `normal_balance` is derived from `type`; `opening_balance` books an opening entry. |
| Categories, contacts, tags | `GET/POST /{resource}/`, `GET/PATCH /{resource}/{id}/`, `POST /{resource}/{id}/archive/` | |
| Income ⟳ | `GET/POST /income/`, `GET /income/{id}/` | `{amount, category_id, destination_account_id, occurred_on, contact_id?, reference?, notes?}` |
| Expenses ⟳ | `GET/POST /expenses/`, `GET /expenses/{id}/` | `{amount, category_id, source_account_id, occurred_on, ...}` |
| Transfers ⟳ | `GET/POST /transfers/` | `{from_account_id, to_account_id, amount, occurred_on, description?}`. Between currencies add `to_amount` (what arrived), and `exchange_rate` (sender's currency to base) when neither side is the base currency. |
| Transactions | `GET /transactions/`, `GET /transactions/{id}/` | Filters: `type` (comma list), `status`, `account_id`, `category_id`, `date_from`, `date_to`, `q`. Each row carries a backend-classified `type`. |
| Reversal ⟳ | `POST /transactions/{id}/reverse/` | Adds an opposite entry; history is never edited. Reversing a loan repayment restores the loan's outstanding amount. Refused for reversals and investment trades (correct a trade with the opposite trade). |
| Loans ⟳ | `GET/POST /debts/`, `GET /debts/{id}/`, `GET/POST /debts/{id}/repayments/` | Creating a loan books the liability (or receivable). Repayments split principal and interest. |
| Investments ⟳ | `GET/POST /investments/trades/`, `GET/POST /investments/dividends/`, `GET /reports/investment-position-summary/` | Holdings are at cost; there is no price feed. |
| Recurring ⟳ | `GET/POST /recurring-transactions/`, `PATCH /recurring-transactions/{id}/`, `POST /recurring-transactions/{id}/run/` | `run` takes `{action: "post" \| "skip"}`, posts the next due occurrence through the normal income/expense/transfer flow and advances the schedule. An occurrence can be posted only once. The `process_recurring_transactions` command does the same for every due item. |
| Zerodha (Kite + Coin) | `GET /integrations/zerodha/portfolio/`, `GET /integrations/zerodha/analytics/`, `POST /integrations/zerodha/connect/`, `GET /integrations/zerodha/callback/`, `POST /integrations/zerodha/sync/`, `POST /integrations/zerodha/disconnect/` | Read-only portfolio: stocks and ETFs from Kite, mutual funds from Coin, with value, profit/loss, today's change, allocation and a daily value history. `connect` returns Zerodha's sign-in URL; Zerodha redirects the browser to `callback`, which redirects to the app with `?broker=zerodha&result=connected\|cancelled\|error`. `analytics` adds uninvested cash, concentration, winners and losers, change over 1D/1W/1M/3M/6M/1Y (with market movement separated from money added), movement by holding, Coin SIPs, open positions and plain-language observations. `GET /dashboard/summary/` carries a `broker` headline. Needs `KITE_API_KEY` and `KITE_API_SECRET`. Broker figures are stored apart from the ledger and never change balances, net worth or reports. |
| Dashboard | `GET /dashboard/summary/?date_from&date_to&months` | Net worth, period totals, category breakdowns, monthly cash flow, recent transactions in one consistent snapshot. |
| Reports | `GET /reports/cashflow/`, `/reports/spending-by-category/`, `/reports/income-by-category/`, plus the view-backed reports | Same queries as the dashboard. |
| Members | `GET/POST /memberships/`, `PATCH /memberships/{id}/` | Add by email with a role (`ADMIN`, `MEMBER`, `VIEWER`); a `password` creates the account if none exists. Change `role` or `status` (`ACTIVE`/`SUSPENDED`). Nobody can change their own access or the owner's. |
| Activity | `GET /activity/`, `GET /audit/`, `GET /security-audit/` | `/activity/` is who-did-what without row snapshots; `/audit/` has the full records. |

The low-level journal endpoints (`POST /transactions/`, `/entries/`, `/post/`,
`/cancel/`) remain for advanced use; the web app does not call them.

## How figures are derived

Income and expense totals are sums of COMPLETED ledger entries on INCOME and
EXPENSE accounts. A transfer never touches those accounts, so it cannot be
counted as either. A reversal nets out in the period it is dated in. Category
breakdowns attribute each such entry to its income/expense record (following a
reversal back to the original), so their total always equals the ledger total.
Net worth is asset balances minus liability balances in the workspace currency.
