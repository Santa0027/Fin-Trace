"""Read-side queries that turn ledger rows into what the product shows.

Every figure here is derived from COMPLETED ledger transactions. Income and
expense totals come from entries on INCOME / EXPENSE accounts, so a reversal
nets out in the period it is dated in and transfers (which never touch those
accounts) cannot be counted as income or spending. The dashboard and the
reports call the same methods, which is what keeps their numbers equal.
"""
import json
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo
from decimal import Decimal
from uuid import UUID

from FinTrace.apps.core.infrastructure.database.utils import DatabaseExecutor

ASSET_TYPES = ("BANK", "CASH", "WALLET", "BROKER", "INVESTMENT", "FOREX")
LIABILITY_TYPES = ("CREDIT_CARD", "LIABILITY")
NOMINAL_TYPES = ("INCOME", "EXPENSE")

NORMAL_BALANCE_BY_TYPE = {
    "BANK": "DEBIT", "CASH": "DEBIT", "WALLET": "DEBIT", "BROKER": "DEBIT",
    "INVESTMENT": "DEBIT", "FOREX": "DEBIT", "EXPENSE": "DEBIT", "OTHER": "DEBIT",
    "CREDIT_CARD": "CREDIT", "LIABILITY": "CREDIT", "EQUITY": "CREDIT", "INCOME": "CREDIT",
}


def account_category(account_type: str, normal_balance: str) -> str:
    if account_type in ASSET_TYPES:
        return "ASSET"
    if account_type in LIABILITY_TYPES:
        return "LIABILITY"
    if account_type in NOMINAL_TYPES or account_type == "EQUITY":
        return account_type
    return "ASSET" if normal_balance == "DEBIT" else "LIABILITY"


def _decode_json(value):
    return json.loads(value) if isinstance(value, str) else value


_SIGNED_INCOME = "CASE WHEN le.credit_amount > 0 THEN le.base_amount ELSE -le.base_amount END"
_SIGNED_EXPENSE = "CASE WHEN le.debit_amount > 0 THEN le.base_amount ELSE -le.base_amount END"

_TRANSACTIONS_SQL = """
WITH tx AS (
    SELECT lt.id, lt.occurred_at, lt.reference,
           CASE WHEN lt.reverses_transaction_id IS NOT NULL
                THEN 'Reversal: ' || COALESCE(NULLIF(orig.description, ''), NULLIF(orig.reference, ''), 'earlier transaction')
                ELSE lt.description END AS description,
           lt.status, lt.reverses_transaction_id, lt.created_at,
           rev.id AS reversed_by_transaction_id,
           ir.id AS income_id, er.id AS expense_id,
           COALESCE(ir.category_id, er.category_id) AS category_id,
           COALESCE(ir.contact_id, er.contact_id) AS contact_id,
           dr.debt_id, it.id AS trade_id, idv.id AS dividend_id,
           CASE
               WHEN lt.reverses_transaction_id IS NOT NULL THEN 'REVERSAL'
               WHEN ir.id IS NOT NULL THEN 'INCOME'
               WHEN er.id IS NOT NULL THEN 'EXPENSE'
               WHEN dr.id IS NOT NULL THEN 'DEBT_PAYMENT'
               WHEN it.id IS NOT NULL THEN 'INVESTMENT_' || it.trade_type
               WHEN idv.id IS NOT NULL THEN 'DIVIDEND'
               WHEN agg.line_count = 2 AND agg.nominal_lines = 0 AND agg.equity_lines = 0 THEN 'TRANSFER'
               ELSE 'JOURNAL'
           END AS type,
           COALESCE(ir.amount, er.amount, agg.total_debit, 0) AS amount,
           agg.currency_id, agg.source_account_id, agg.source_account_name,
           agg.destination_account_id, agg.destination_account_name, agg.entries
      FROM fintrace.ledger_transactions lt
      LEFT JOIN fintrace.ledger_transactions rev
             ON rev.tenant_id = lt.tenant_id AND rev.reverses_transaction_id = lt.id AND rev.status = 'COMPLETED'
      LEFT JOIN fintrace.ledger_transactions orig
             ON orig.tenant_id = lt.tenant_id AND orig.id = lt.reverses_transaction_id
      LEFT JOIN fintrace.income_records ir ON ir.tenant_id = lt.tenant_id AND ir.ledger_transaction_id = lt.id
      LEFT JOIN fintrace.expense_records er ON er.tenant_id = lt.tenant_id AND er.ledger_transaction_id = lt.id
      LEFT JOIN fintrace.debt_repayments dr ON dr.tenant_id = lt.tenant_id AND dr.ledger_transaction_id = lt.id
      LEFT JOIN fintrace.investment_trades it ON it.tenant_id = lt.tenant_id AND it.ledger_transaction_id = lt.id
      LEFT JOIN fintrace.investment_dividends idv ON idv.tenant_id = lt.tenant_id AND idv.ledger_transaction_id = lt.id
      LEFT JOIN LATERAL (
          SELECT count(*) AS line_count,
                 count(*) FILTER (WHERE a.type IN ('INCOME','EXPENSE')) AS nominal_lines,
                 count(*) FILTER (WHERE a.type = 'EQUITY') AS equity_lines,
                 sum(le.debit_amount) AS total_debit,
                 (array_agg(le.currency_id ORDER BY le.id))[1] AS currency_id,
                 (array_agg(a.id ORDER BY le.credit_amount DESC, le.id)
                     FILTER (WHERE le.credit_amount > 0 AND a.type NOT IN ('INCOME','EXPENSE')))[1] AS source_account_id,
                 (array_agg(a.name ORDER BY le.credit_amount DESC, le.id)
                     FILTER (WHERE le.credit_amount > 0 AND a.type NOT IN ('INCOME','EXPENSE')))[1] AS source_account_name,
                 (array_agg(a.id ORDER BY le.debit_amount DESC, le.id)
                     FILTER (WHERE le.debit_amount > 0 AND a.type NOT IN ('INCOME','EXPENSE')))[1] AS destination_account_id,
                 (array_agg(a.name ORDER BY le.debit_amount DESC, le.id)
                     FILTER (WHERE le.debit_amount > 0 AND a.type NOT IN ('INCOME','EXPENSE')))[1] AS destination_account_name,
                 jsonb_agg(jsonb_build_object(
                     'id', le.id, 'account_id', le.account_id, 'account_name', a.name, 'account_type', a.type,
                     'debit_amount', le.debit_amount::text, 'credit_amount', le.credit_amount::text
                 ) ORDER BY le.debit_amount DESC, le.id) AS entries
            FROM fintrace.ledger_entries le
            JOIN fintrace.accounts a ON a.tenant_id = le.tenant_id AND a.id = le.account_id
           WHERE le.tenant_id = lt.tenant_id AND le.transaction_id = lt.id
      ) agg ON TRUE
     WHERE lt.tenant_id = fintrace.current_tenant_id()
)
SELECT tx.*, c.name AS category_name, ct.name AS contact_name, cur.code AS currency_code,
       count(*) OVER () AS total_count
  FROM tx
  LEFT JOIN fintrace.categories c ON c.id = tx.category_id
  LEFT JOIN fintrace.contacts ct ON ct.id = tx.contact_id
  LEFT JOIN fintrace.currencies cur ON cur.id = tx.currency_id
"""

_RECORD_TABLES = {"INCOME": "fintrace.income_records", "EXPENSE": "fintrace.expense_records"}


class FinancialReadRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()
        self._timezone: str | None = None

    # -- calendar ----------------------------------------------------------
    @property
    def timezone(self) -> str:
        """The workspace timezone; every period boundary is a local day."""
        if self._timezone is None:
            row = self.db.fetch_one("SELECT timezone FROM fintrace.tenants WHERE id = fintrace.current_tenant_id()")
            self._timezone = (row or {}).get("timezone") or "UTC"
        return self._timezone

    def _day_start(self, day: date) -> datetime:
        return datetime.combine(day, time.min, tzinfo=ZoneInfo(self.timezone))

    def _period_bounds(self, date_from: date, date_to: date) -> list[datetime]:
        return [self._day_start(date_from), self._day_start(date_to + timedelta(days=1))]

    # -- tenant ------------------------------------------------------------
    def tenant_profile(self) -> dict | None:
        return self.db.fetch_one(
            """
            SELECT t.id, t.slug, t.name, t.timezone, t.base_currency_id, c.code AS base_currency_code,
                   c.symbol AS base_currency_symbol, c.decimal_places AS base_currency_decimals
              FROM fintrace.tenants t
              JOIN fintrace.currencies c ON c.id = t.base_currency_id
             WHERE t.id = fintrace.current_tenant_id()
            """
        )

    def has_permissions(self, codes: list[str]) -> dict[str, bool]:
        row = self.db.fetch_one(
            "SELECT " + ", ".join(f"fintrace.has_permission(%s) AS p{i}" for i in range(len(codes))), codes
        )
        return {code: bool(row[f"p{i}"]) for i, code in enumerate(codes)}

    # -- transactions ------------------------------------------------------
    def list_transactions(self, filters: dict, limit: int, offset: int) -> tuple[list[dict], int]:
        where: list[str] = []
        params: list[object] = []
        if filters.get("type"):
            types = [part.strip().upper() for part in str(filters["type"]).split(",") if part.strip()]
            where.append("tx.type = ANY(%s)")
            params.append(types)
        if filters.get("status"):
            where.append("tx.status = %s")
            params.append(str(filters["status"]).upper())
        if filters.get("account_id"):
            where.append(
                "EXISTS (SELECT 1 FROM fintrace.ledger_entries fe WHERE fe.transaction_id = tx.id AND fe.account_id = %s::uuid)"
            )
            params.append(str(filters["account_id"]))
        if filters.get("category_id"):
            where.append("tx.category_id = %s::uuid")
            params.append(str(filters["category_id"]))
        if filters.get("date_from"):
            where.append("tx.occurred_at >= %s")
            params.append(self._day_start(filters["date_from"]))
        if filters.get("date_to"):
            where.append("tx.occurred_at < %s")
            params.append(self._day_start(filters["date_to"] + timedelta(days=1)))
        if filters.get("q"):
            where.append("(tx.reference ILIKE %s OR tx.description ILIKE %s OR c.name ILIKE %s OR ct.name ILIKE %s)")
            pattern = "%" + str(filters["q"]).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            params.extend([pattern] * 4)
        sql = _TRANSACTIONS_SQL + (" WHERE " + " AND ".join(where) if where else "")
        sql += " ORDER BY tx.occurred_at DESC, tx.created_at DESC, tx.id LIMIT %s OFFSET %s"
        rows = self.db.fetch_all(sql, [*params, limit, offset])
        total = rows[0]["total_count"] if rows else 0
        if not rows and offset:
            total = self.count_transactions(filters)
        return [self._transaction_row(row) for row in rows], total

    def count_transactions(self, filters: dict) -> int:
        _, total = self.list_transactions(filters, 1, 0)
        return total

    def get_transaction(self, transaction_id: UUID) -> dict | None:
        row = self.db.fetch_one(_TRANSACTIONS_SQL + " WHERE tx.id = %s::uuid", [str(transaction_id)])
        return self._transaction_row(row) if row else None

    def _transaction_row(self, row: dict) -> dict:
        row = dict(row)
        row.pop("total_count", None)
        row["entries"] = _decode_json(row.get("entries")) or []
        row["is_reversed"] = row["reversed_by_transaction_id"] is not None
        return row

    # -- income / expense records -----------------------------------------
    def list_records(self, kind: str, filters: dict, limit: int, offset: int) -> tuple[list[dict], int]:
        table = _RECORD_TABLES[kind]
        account_side = "debit_amount" if kind == "INCOME" else "credit_amount"
        where = ["r.tenant_id = fintrace.current_tenant_id()"]
        params: list[object] = []
        if filters.get("date_from"):
            where.append("r.occurred_on >= %s")
            params.append(filters["date_from"])
        if filters.get("date_to"):
            where.append("r.occurred_on <= %s")
            params.append(filters["date_to"])
        if filters.get("category_id"):
            where.append("r.category_id = %s::uuid")
            params.append(str(filters["category_id"]))
        if filters.get("id"):
            where.append("r.id = %s::uuid")
            params.append(str(filters["id"]))
        rows = self.db.fetch_all(
            f"""
            SELECT r.id, r.ledger_transaction_id, r.category_id, c.name AS category_name,
                   r.contact_id, ct.name AS contact_name, r.amount, r.currency_id, cur.code AS currency_code,
                   r.occurred_on, r.notes, r.created_at,
                   lt.occurred_at, lt.reference, lt.description, lt.status,
                   rev.id AS reversed_by_transaction_id,
                   acct.account_id, acct.account_name,
                   count(*) OVER () AS total_count
              FROM {table} r
              JOIN fintrace.ledger_transactions lt ON lt.tenant_id = r.tenant_id AND lt.id = r.ledger_transaction_id
              LEFT JOIN fintrace.ledger_transactions rev
                     ON rev.tenant_id = lt.tenant_id AND rev.reverses_transaction_id = lt.id AND rev.status = 'COMPLETED'
              LEFT JOIN fintrace.categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id
              LEFT JOIN fintrace.contacts ct ON ct.tenant_id = r.tenant_id AND ct.id = r.contact_id
              LEFT JOIN fintrace.currencies cur ON cur.id = r.currency_id
              LEFT JOIN LATERAL (
                  SELECT a.id AS account_id, a.name AS account_name
                    FROM fintrace.ledger_entries le
                    JOIN fintrace.accounts a ON a.tenant_id = le.tenant_id AND a.id = le.account_id
                   WHERE le.tenant_id = r.tenant_id AND le.transaction_id = r.ledger_transaction_id
                     AND le.{account_side} > 0 AND a.type NOT IN ('INCOME','EXPENSE')
                   ORDER BY le.{account_side} DESC, le.id
                   LIMIT 1
              ) acct ON TRUE
             WHERE {' AND '.join(where)}
             ORDER BY r.occurred_on DESC, r.created_at DESC, r.id
             LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],
        )
        total = rows[0]["total_count"] if rows else 0
        for row in rows:
            row.pop("total_count")
            row["is_reversed"] = row["reversed_by_transaction_id"] is not None
        return rows, total

    # -- accounts ----------------------------------------------------------
    def list_accounts(self, limit: int | None = None, offset: int = 0, account_id: UUID | None = None) -> list[dict]:
        where = "WHERE a.tenant_id = fintrace.current_tenant_id()"
        params: list[object] = []
        if account_id is not None:
            where += " AND a.id = %s::uuid"
            params.append(str(account_id))
        rows = self.db.fetch_all(
            f"""
            WITH balances AS MATERIALIZED (
                SELECT account_id, balance_amount, balance_base_amount FROM fintrace.account_balances
            )
            SELECT a.id, a.name, a.type, a.normal_balance, a.institution, a.account_number,
                   a.currency_id, cur.code AS currency_code, cur.symbol AS currency_symbol,
                   a.is_active, a.is_system, a.archived_at, a.notes, a.created_at, a.updated_at,
                   COALESCE(b.balance_amount, 0) AS balance_amount,
                   COALESCE(b.balance_base_amount, 0) AS balance_base_amount
              FROM fintrace.accounts a
              JOIN fintrace.currencies cur ON cur.id = a.currency_id
              LEFT JOIN balances b ON b.account_id = a.id
              {where}
             ORDER BY a.is_system, a.is_active DESC, a.name, a.created_at
             LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],  # LIMIT NULL means no limit
        )
        for row in rows:
            row["category"] = account_category(row["type"], row["normal_balance"])
            row["is_payment_account"] = (
                row["is_active"] and not row["is_system"] and row["category"] in {"ASSET", "LIABILITY"}
            )
        return rows

    def balance_sheet(self) -> dict:
        accounts = [row for row in self.list_accounts() if row["category"] in {"ASSET", "LIABILITY"}]
        assets = sum((row["balance_base_amount"] for row in accounts if row["category"] == "ASSET"), Decimal("0"))
        liabilities = sum((row["balance_base_amount"] for row in accounts if row["category"] == "LIABILITY"), Decimal("0"))
        visible = [row for row in accounts if row["is_active"] or row["balance_base_amount"] != 0]
        return {"accounts": visible, "assets": assets, "liabilities": liabilities, "net_worth": assets - liabilities}

    # -- ledger-derived reporting -----------------------------------------
    def period_totals(self, date_from: date, date_to: date) -> dict:
        row = self.db.fetch_one(
            f"""
            SELECT COALESCE(sum({_SIGNED_INCOME}) FILTER (WHERE a.type = 'INCOME'), 0) AS income,
                   COALESCE(sum({_SIGNED_EXPENSE}) FILTER (WHERE a.type = 'EXPENSE'), 0) AS expenses
              FROM fintrace.ledger_entries le
              JOIN fintrace.ledger_transactions lt ON lt.tenant_id = le.tenant_id AND lt.id = le.transaction_id
              JOIN fintrace.accounts a ON a.tenant_id = le.tenant_id AND a.id = le.account_id
             WHERE le.tenant_id = fintrace.current_tenant_id()
               AND lt.status = 'COMPLETED'
               AND a.type IN ('INCOME','EXPENSE')
               AND lt.occurred_at >= %s AND lt.occurred_at < %s
            """,
            self._period_bounds(date_from, date_to),
        )
        income, expenses = row["income"], row["expenses"]
        net = income - expenses
        savings_rate = (net / income * 100).quantize(Decimal("0.1")) if income > 0 else None
        return {"income": income, "expenses": expenses, "net_cash_flow": net, "savings_rate": savings_rate}

    def category_breakdown(self, kind: str, date_from: date, date_to: date) -> dict:
        table = _RECORD_TABLES[kind]
        signed = _SIGNED_INCOME if kind == "INCOME" else _SIGNED_EXPENSE
        rows = self.db.fetch_all(
            f"""
            SELECT r.category_id, COALESCE(c.name, 'Uncategorized') AS category,
                   sum({signed}) AS amount,
                   count(DISTINCT lt.id) FILTER (WHERE lt.reverses_transaction_id IS NULL) AS count
              FROM fintrace.ledger_entries le
              JOIN fintrace.ledger_transactions lt ON lt.tenant_id = le.tenant_id AND lt.id = le.transaction_id
              JOIN fintrace.accounts a ON a.tenant_id = le.tenant_id AND a.id = le.account_id
              LEFT JOIN {table} r
                     ON r.tenant_id = lt.tenant_id
                    AND r.ledger_transaction_id = COALESCE(lt.reverses_transaction_id, lt.id)
              LEFT JOIN fintrace.categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id
             WHERE le.tenant_id = fintrace.current_tenant_id()
               AND lt.status = 'COMPLETED'
               AND a.type = %s
               AND lt.occurred_at >= %s AND lt.occurred_at < %s
             GROUP BY r.category_id, COALESCE(c.name, 'Uncategorized')
            HAVING sum({signed}) <> 0
             ORDER BY sum({signed}) DESC, 2
            """,
            [kind, *self._period_bounds(date_from, date_to)],
        )
        total = sum((row["amount"] for row in rows), Decimal("0"))
        for row in rows:
            row["percentage"] = float((row["amount"] / total * 100).quantize(Decimal("0.1"))) if total > 0 else 0.0
        return {"total": total, "results": rows}

    def monthly_cashflow(self, months: int, until: date) -> list[dict]:
        last_month = until.replace(day=1)
        year, month = last_month.year, last_month.month - (months - 1)
        while month <= 0:
            month += 12
            year -= 1
        first_month = date(year, month, 1)
        next_month = date(last_month.year + (last_month.month == 12), last_month.month % 12 + 1, 1)
        rows = self.db.fetch_all(
            f"""
            WITH months AS (
                SELECT generate_series(%s::date, %s::date, interval '1 month')::date AS month_start
            ), totals AS (
                SELECT date_trunc('month', lt.occurred_at AT TIME ZONE %s)::date AS month_start,
                       COALESCE(sum({_SIGNED_INCOME}) FILTER (WHERE a.type = 'INCOME'), 0) AS income,
                       COALESCE(sum({_SIGNED_EXPENSE}) FILTER (WHERE a.type = 'EXPENSE'), 0) AS expenses
                  FROM fintrace.ledger_entries le
                  JOIN fintrace.ledger_transactions lt ON lt.tenant_id = le.tenant_id AND lt.id = le.transaction_id
                  JOIN fintrace.accounts a ON a.tenant_id = le.tenant_id AND a.id = le.account_id
                 WHERE le.tenant_id = fintrace.current_tenant_id()
                   AND lt.status = 'COMPLETED'
                   AND a.type IN ('INCOME','EXPENSE')
                   AND lt.occurred_at >= %s AND lt.occurred_at < %s
                 GROUP BY 1
            )
            SELECT m.month_start, COALESCE(t.income, 0) AS income, COALESCE(t.expenses, 0) AS expenses
              FROM months m
              LEFT JOIN totals t USING (month_start)
             ORDER BY m.month_start
            """,
            [first_month, last_month, self.timezone, self._day_start(first_month), self._day_start(next_month)],
        )
        for row in rows:
            row["month"] = row["month_start"].strftime("%b %Y")
            row["net"] = row["income"] - row["expenses"]
        return rows

    # -- debts -------------------------------------------------------------
    def list_debts(self, limit: int, offset: int, debt_id: UUID | None = None) -> list[dict]:
        where = "WHERE d.tenant_id = fintrace.current_tenant_id()"
        params: list[object] = []
        if debt_id is not None:
            where += " AND d.id = %s::uuid"
            params.append(str(debt_id))
        return self.db.fetch_all(
            f"""
            SELECT d.id, d.type, d.contact_id, ct.name AS contact_name, d.principal_amount,
                   d.currency_id, cur.code AS currency_code, d.interest_rate, d.start_date, d.due_date,
                   d.status, d.notes, d.created_at, d.updated_at,
                   COALESCE(r.repaid_principal, 0) AS repaid_principal,
                   d.principal_amount - COALESCE(r.repaid_principal, 0) AS outstanding_principal,
                   COALESCE(r.interest_paid, 0) AS interest_paid,
                   COALESCE(r.repayment_count, 0) AS repayment_count,
                   r.last_repaid_on
              FROM fintrace.debts d
              LEFT JOIN fintrace.contacts ct ON ct.tenant_id = d.tenant_id AND ct.id = d.contact_id
              JOIN fintrace.currencies cur ON cur.id = d.currency_id
              LEFT JOIN LATERAL (
                  SELECT sum(principal_amount) AS repaid_principal, sum(interest_amount) AS interest_paid,
                         count(*) AS repayment_count, max(repaid_on) AS last_repaid_on
                    FROM fintrace.debt_repayments dr
                   WHERE dr.tenant_id = d.tenant_id AND dr.debt_id = d.id
                     AND fintrace.debt_repayment_is_effective(dr.tenant_id, dr.ledger_transaction_id)
              ) r ON TRUE
              {where}
             ORDER BY (d.status = 'ACTIVE') DESC, d.due_date NULLS LAST, d.created_at DESC
             LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],
        )

    def list_debt_repayments(self, debt_id: UUID, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all(
            """
            SELECT dr.id, dr.debt_id, dr.ledger_transaction_id, dr.principal_amount, dr.interest_amount,
                   dr.total_amount, dr.repaid_on, dr.notes, dr.created_at,
                   NOT fintrace.debt_repayment_is_effective(dr.tenant_id, dr.ledger_transaction_id) AS is_reversed
              FROM fintrace.debt_repayments dr
             WHERE dr.tenant_id = fintrace.current_tenant_id() AND dr.debt_id = %s::uuid
             ORDER BY dr.repaid_on DESC, dr.created_at DESC
             LIMIT %s OFFSET %s
            """,
            [str(debt_id), limit, offset],
        )

    def debt_exposure(self) -> dict:
        row = self.db.fetch_one(
            """
            SELECT COALESCE(sum(outstanding_principal) FILTER (WHERE type = 'PAYABLE' AND status = 'ACTIVE'), 0) AS payable,
                   COALESCE(sum(outstanding_principal) FILTER (WHERE type = 'RECEIVABLE' AND status = 'ACTIVE'), 0) AS receivable,
                   count(*) FILTER (WHERE status = 'ACTIVE') AS active_count
              FROM fintrace.debt_balances
            """
        )
        return row or {"payable": Decimal("0"), "receivable": Decimal("0"), "active_count": 0}

    # -- investments -------------------------------------------------------
    def list_holdings(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all(
            """
            SELECT s.position_id, s.portfolio_id, pf.name AS portfolio_name, s.instrument_id,
                   s.symbol, s.instrument_name, i.instrument_type, s.quantity, s.average_cost,
                   round(s.quantity * s.average_cost, cur.decimal_places) AS cost_value,
                   s.instrument_currency_id AS currency_id, cur.code AS currency_code, s.updated_at
              FROM fintrace.investment_position_summary s
              JOIN fintrace.investment_instruments i ON i.id = s.instrument_id
              JOIN fintrace.investment_portfolios pf ON pf.tenant_id = s.tenant_id AND pf.id = s.portfolio_id
              JOIN fintrace.currencies cur ON cur.id = s.instrument_currency_id
             WHERE s.quantity > 0
             ORDER BY s.symbol
             LIMIT %s OFFSET %s
            """,
            [limit, offset],
        )

    def list_trades(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all(
            """
            SELECT t.id, t.portfolio_id, t.instrument_id, i.symbol, i.name AS instrument_name,
                   t.ledger_transaction_id, t.trade_type, t.quantity, t.price, t.fees, t.realized_pnl,
                   t.traded_at, t.cash_account_id, a.name AS cash_account_name,
                   round(t.quantity * t.price, cur.decimal_places) AS gross_amount, cur.code AS currency_code
              FROM fintrace.investment_trades t
              JOIN fintrace.investment_instruments i ON i.id = t.instrument_id
              JOIN fintrace.currencies cur ON cur.id = i.currency_id
              LEFT JOIN fintrace.accounts a ON a.tenant_id = t.tenant_id AND a.id = t.cash_account_id
             WHERE t.tenant_id = fintrace.current_tenant_id()
             ORDER BY t.traded_at DESC, t.created_at DESC
             LIMIT %s OFFSET %s
            """,
            [limit, offset],
        )

    def list_dividends(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all(
            """
            SELECT d.id, d.portfolio_id, d.instrument_id, i.symbol, i.name AS instrument_name,
                   d.ledger_transaction_id, d.amount, d.currency_id, cur.code AS currency_code,
                   d.paid_on, d.notes, d.cash_account_id, a.name AS cash_account_name,
                   NOT fintrace.debt_repayment_is_effective(d.tenant_id, d.ledger_transaction_id) AS is_reversed
              FROM fintrace.investment_dividends d
              JOIN fintrace.investment_instruments i ON i.id = d.instrument_id
              JOIN fintrace.currencies cur ON cur.id = d.currency_id
              LEFT JOIN fintrace.accounts a ON a.tenant_id = d.tenant_id AND a.id = d.cash_account_id
             WHERE d.tenant_id = fintrace.current_tenant_id()
             ORDER BY d.paid_on DESC, d.created_at DESC
             LIMIT %s OFFSET %s
            """,
            [limit, offset],
        )

    def investment_exposure(self) -> dict:
        row = self.db.fetch_one(
            """
            SELECT COALESCE(sum(s.quantity * s.average_cost), 0) AS cost_basis,
                   count(*) FILTER (WHERE s.quantity > 0) AS holding_count
              FROM fintrace.investment_position_summary s
            """
        )
        return row or {"cost_basis": Decimal("0"), "holding_count": 0}

    # -- members -----------------------------------------------------------
    def list_members(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all(
            """
            SELECT m.id, m.user_id, u.username, u.email, u.first_name, u.last_name,
                   m.status, m.joined_at, (t.owner_id = m.user_id) AS is_owner,
                   COALESCE((
                       SELECT array_agg(r.code ORDER BY r.code)
                         FROM fintrace.rbac_membership_roles mr
                         JOIN fintrace.rbac_roles r ON r.id = mr.role_id
                        WHERE mr.membership_id = m.id
                   ), ARRAY[]::varchar[]) AS role_codes,
                   COALESCE((
                       SELECT array_agg(r.name ORDER BY r.name)
                         FROM fintrace.rbac_membership_roles mr
                         JOIN fintrace.rbac_roles r ON r.id = mr.role_id
                        WHERE mr.membership_id = m.id
                   ), ARRAY[]::varchar[]) AS roles
              FROM fintrace.tenant_memberships m
              JOIN fintrace.tenant_users u ON u.id = m.user_id
              JOIN fintrace.tenants t ON t.id = m.tenant_id
             WHERE m.tenant_id = fintrace.current_tenant_id()
             ORDER BY u.first_name, u.username
             LIMIT %s OFFSET %s
            """,
            [limit, offset],
        )

    # -- recurring ---------------------------------------------------------
    def list_recurring(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all(
            """
            SELECT rt.id, rt.transaction_type, rt.description, rt.amount, rt.currency_id, cur.code AS currency_code,
                   rt.frequency, rt.start_date, rt.end_date, rt.next_run_at, rt.is_active,
                   rt.source_account_id, sa.name AS source_account_name,
                   rt.destination_account_id, da.name AS destination_account_name,
                   rt.category_id, c.name AS category_name,
                   last.scheduled_for AS last_scheduled_for, last.status AS last_status
              FROM fintrace.recurring_transactions rt
              JOIN fintrace.currencies cur ON cur.id = rt.currency_id
              LEFT JOIN fintrace.accounts sa ON sa.tenant_id = rt.tenant_id AND sa.id = rt.source_account_id
              LEFT JOIN fintrace.accounts da ON da.tenant_id = rt.tenant_id AND da.id = rt.destination_account_id
              LEFT JOIN fintrace.categories c ON c.tenant_id = rt.tenant_id AND c.id = rt.category_id
              LEFT JOIN LATERAL (
                  SELECT o.scheduled_for, o.status
                    FROM fintrace.recurring_transaction_occurrences o
                   WHERE o.tenant_id = rt.tenant_id AND o.recurring_transaction_id = rt.id
                   ORDER BY o.scheduled_for DESC LIMIT 1
              ) last ON TRUE
             WHERE rt.tenant_id = fintrace.current_tenant_id()
             ORDER BY rt.is_active DESC, rt.next_run_at, rt.created_at
             LIMIT %s OFFSET %s
            """,
            [limit, offset],
        )

    def due_recurring_ids(self, today: date, limit: int) -> list[UUID]:
        rows = self.db.fetch_all(
            """
            SELECT id FROM fintrace.recurring_transactions
             WHERE tenant_id = fintrace.current_tenant_id() AND is_active AND next_run_at <= %s
             ORDER BY next_run_at, created_at LIMIT %s
            """,
            [today, limit],
        )
        return [row["id"] for row in rows]

    # -- audit -------------------------------------------------------------
    def list_activity(self, limit: int, offset: int) -> list[dict]:
        """Who changed what, without the row snapshots (those stay behind /audit/)."""
        return self.db.fetch_all(
            """
            SELECT e.id, e.occurred_at, e.action, e.entity_type, e.entity_id, e.actor_user_id,
                   NULLIF(btrim(u.first_name || ' ' || u.last_name), '') AS actor_name, u.username AS actor_username
              FROM fintrace.audit_events e
              LEFT JOIN fintrace.users u ON u.id = e.actor_user_id
             WHERE e.tenant_id = fintrace.current_tenant_id()
               AND e.entity_type NOT IN ('ledger_entries', 'idempotency_operations')
             ORDER BY e.occurred_at DESC
             LIMIT %s OFFSET %s
            """,
            [limit, offset],
        )
