# Database patches

`schema.sql` at the repository root is the authoritative bootstrap for an empty
database. The files here bring a database that was bootstrapped from an earlier
`schema.sql` up to date. Each one is idempotent, already folded into
`schema.sql`, and must be run as the schema owner:

```
python scripts/bootstrap_db.py --database <database>
```

The bootstrap script applies every patch in order to an existing database and
re-applies the runtime grants. To run one by hand instead, execute it as the
schema owner (`SET ROLE fintrace_owner;` first).

| Patch | Why |
|-------|-----|
| `001_fix_investment_first_buy.sql` | The first trade in any instrument failed with a NULL quantity. |
| `002_list_user_tenants.sql` | Sign-in could not discover a user's workspaces under row-level security. |
| `003_timezone_and_reversible_repayments.sql` | Workspace timezone; loan balances ignore repayments whose ledger entry was reversed. |
| `004_rls_permission_once_per_statement.sql` | Row-level security evaluated the permission check per row, making lists and reports slow. |
| `005_broker_connections.sql` | Tables for the Zerodha (Kite + Coin) connection and its portfolio snapshots. |
| `006_broker_analytics.sql` | Broker cash balance, SIPs, open positions and per-holding daily history for portfolio analysis. |
