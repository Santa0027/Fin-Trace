# FinTrace

Multi-tenant personal and small-business finance on a double-entry ledger.

- **Backend**: Django 5.2 (`FinTrace/`), PostgreSQL 16 with row-level security.
- **Frontend**: React + TypeScript + Vite (`frontend/`).
- **API**: `docs/api.md`.

Every figure the app shows is derived from the ledger. People record income,
expenses and transfers in plain terms; the backend turns each into a balanced,
posted journal entry and never edits one afterwards (corrections are reversals).

## Set up from scratch

Requirements: Python 3.12+, Node 20+, PostgreSQL 16+.

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # set DATABASE_PASSWORD and SECRET_KEY at least
```

### 1. Create the database

One command creates the roles, the database, the schema, Django's tables and the
runtime grants, and can seed currencies and your first sign-in:

```bash
.venv/bin/python scripts/bootstrap_db.py \
    --seed-currencies \
    --admin-email you@example.com --admin-name "Your Name" \
    --workspace-name "Home" --workspace-currency USD --workspace-timezone Europe/London
```

It reads `.env`, asks for the PostgreSQL superuser password (or takes
`FINTRACE_DB_ADMIN_PASSWORD`) and for the new user's password (or
`FINTRACE_ADMIN_PASSWORD`). It is safe to run again at any time: on an existing
database it applies `db/patches/` and re-applies grants, and never drops data.
`--help` lists every option.

No PostgreSQL to hand? `docker run -d --name fintrace-db -e POSTGRES_PASSWORD=<pw> -p 127.0.0.1:5432:5432 postgres:16`

### Demo data (optional)

```bash
.venv/bin/python scripts/seed_demo.py --currency USD --timezone Europe/London
```

Creates three demo sign-ins (owner, member, read-only viewer) and two workspaces
filled through the normal application flows: six months of income, expenses and
transfers, a credit card, loans, investments, recurring items, goals, assets,
subscriptions and tags. It prints the sign-ins and a generated password (or use
`--password` / `FINTRACE_DEMO_PASSWORD`). Running it again changes nothing;
`--suffix name` creates a second, separate set. FinTrace never deletes financial
records, so seed a scratch database, not production.

### 2. Run it

```bash
.venv/bin/python manage.py runserver            # API on http://127.0.0.1:8000
cd frontend && npm install && npm run dev       # app on http://127.0.0.1:3000
```

### Zerodha portfolio (optional)

The Investments screen can show your Zerodha portfolio at market prices: stocks
and ETFs from Kite and mutual funds from Coin, with profit and loss, today's
change, allocation and a value history. It is read-only and separate from the
ledger.

1. Create an app at <https://developers.kite.trade> (Zerodha charges for API access).
2. Set its redirect URL to `<your site>/api/v1/integrations/zerodha/callback/`
   (for local development: `http://127.0.0.1:3000/api/v1/integrations/zerodha/callback/`).
3. Put `KITE_API_KEY` and `KITE_API_SECRET` in `.env` and restart the backend.
4. In the app: Investments → Zerodha portfolio → Connect Zerodha.

Once connected you get, all inside FinTrace:

- **Investments → Zerodha portfolio → Holdings**: value, profit and loss, today's
  change, split between Kite and Coin, best and worst performers, value over time.
- **Analysis, SIPs and positions** (also under **Reports → Zerodha portfolio**):
  what stands out, uninvested cash, how concentrated the portfolio is, change over
  1 day to 1 year with market movement separated from money you added, movement
  by holding, your Coin SIPs and monthly commitment, open positions, and a CSV export.
- **Dashboard**: a portfolio card (for reference; it is not added to net worth).

FinTrace stores one snapshot per day you refresh, so the change-over-time tables
fill in as you keep syncing; they cannot show days before you first connected.

Zerodha signs every connected app out at 6 AM India time each day, so figures are
refreshed when someone reconnects; FinTrace keeps showing the last synced figures
in between. The broker token is stored encrypted and never leaves the server.

### 3. Recurring items (optional automation)

People can record each recurring item when it is due from the Recurring screen.
To post due items automatically, schedule this per workspace (for example daily):

```bash
.venv/bin/python manage.py process_recurring_transactions --tenant-id <uuid> --user-id <member uuid>
```

## Tests

```bash
# Backend: needs a throwaway database whose name contains "integration" or "test".
# .env.integration holds its connection settings; build it once with:
set -a; . ./.env.integration; set +a
FINTRACE_DB_ADMIN_USER=<superuser> FINTRACE_DB_ADMIN_PASSWORD=<pw> \
    .venv/bin/python scripts/bootstrap_db.py --seed-currencies
./run_tests.sh                                   # integration tests against real PostgreSQL
.venv/bin/python -m pytest FinTrace -q           # unit tests

# Frontend
cd frontend && npm run lint && npm test && npm run build
```

## Production checklist

See `docs/production-readiness.md`. In short: `ENV=production`, a real
`SECRET_KEY`, TLS in front, the app served from the same origin as `/api`, the
runtime role from the bootstrap script (never a superuser), and
`manage.py validate_runtime_database --strict` passing.
