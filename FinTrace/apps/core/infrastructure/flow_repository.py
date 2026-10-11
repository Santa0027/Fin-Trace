"""Lookups and small writes the human-level flows need to resolve what a user picked."""
from uuid import UUID

from FinTrace.apps.core.infrastructure.database.utils import DatabaseExecutor


class FlowRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def account(self, account_id: UUID) -> dict | None:
        return self.db.fetch_one(
            """
            SELECT a.id, a.name, a.type, a.normal_balance, a.currency_id, a.is_active, a.is_system,
                   c.decimal_places
              FROM fintrace.accounts a
              JOIN fintrace.currencies c ON c.id = a.currency_id
             WHERE a.tenant_id = fintrace.current_tenant_id() AND a.id = %s::uuid
            """,
            [str(account_id)],
        )

    def category(self, category_id: UUID) -> dict | None:
        return self.db.fetch_one(
            "SELECT id, name, type, is_active FROM fintrace.categories WHERE tenant_id = fintrace.current_tenant_id() AND id = %s::uuid",
            [str(category_id)],
        )

    def contact(self, contact_id: UUID) -> dict | None:
        return self.db.fetch_one(
            "SELECT id, name, status FROM fintrace.contacts WHERE tenant_id = fintrace.current_tenant_id() AND id = %s::uuid",
            [str(contact_id)],
        )

    def find_or_create_contact(self, tenant_id: UUID, name: str) -> UUID:
        row = self.db.fetch_one(
            """
            SELECT id FROM fintrace.contacts
             WHERE tenant_id = %s::uuid AND lower(name) = lower(%s) AND status = 'ACTIVE'
             ORDER BY created_at LIMIT 1
            """,
            [str(tenant_id), name],
        )
        if row:
            return row["id"]
        return self.db.execute_returning_id(
            "INSERT INTO fintrace.contacts (tenant_id, name) VALUES (%s::uuid, %s) RETURNING id", [str(tenant_id), name]
        )

    def timezone(self) -> str:
        row = self.db.fetch_one("SELECT timezone FROM fintrace.tenants WHERE id = fintrace.current_tenant_id()")
        return (row or {}).get("timezone") or "UTC"

    def base_currency(self) -> dict:
        return self.db.fetch_one(
            """
            SELECT c.id, c.code, c.decimal_places
              FROM fintrace.tenants t JOIN fintrace.currencies c ON c.id = t.base_currency_id
             WHERE t.id = fintrace.current_tenant_id()
            """
        )

    def currency(self, currency_id: UUID) -> dict | None:
        return self.db.fetch_one(
            "SELECT id, code, decimal_places FROM fintrace.currencies WHERE id = %s::uuid AND is_active", [str(currency_id)]
        )

    # -- debts -------------------------------------------------------------
    def create_debt(self, tenant_id: UUID, debt_type: str, contact_id: UUID, principal, currency_id: UUID, interest_rate, start_date, due_date, notes: str) -> UUID:
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.debts (tenant_id, type, contact_id, principal_amount, currency_id, interest_rate, start_date, due_date, notes)
            VALUES (%s::uuid, %s, %s::uuid, %s, %s::uuid, %s, %s, %s, %s)
            RETURNING id
            """,
            [str(tenant_id), debt_type, str(contact_id), principal, str(currency_id), interest_rate, start_date, due_date, notes],
        )

    def debt_for_update(self, debt_id: UUID) -> dict | None:
        return self.db.fetch_one(
            """
            SELECT d.id, d.type, d.currency_id, d.status, d.principal_amount, d.contact_id, ct.name AS contact_name,
                   d.principal_amount - COALESCE((
                       SELECT sum(r.principal_amount) FROM fintrace.debt_repayments r
                        WHERE r.tenant_id = d.tenant_id AND r.debt_id = d.id
                          AND fintrace.debt_repayment_is_effective(r.tenant_id, r.ledger_transaction_id)), 0) AS outstanding_principal
              FROM fintrace.debts d
              LEFT JOIN fintrace.contacts ct ON ct.tenant_id = d.tenant_id AND ct.id = d.contact_id
             WHERE d.tenant_id = fintrace.current_tenant_id() AND d.id = %s::uuid
               FOR UPDATE OF d
            """,
            [str(debt_id)],
        )

    # -- investments -------------------------------------------------------
    def instrument(self, instrument_id: UUID) -> dict | None:
        return self.db.fetch_one(
            """
            SELECT id, symbol, name, currency_id FROM fintrace.investment_instruments
             WHERE id = %s::uuid AND (tenant_id IS NULL OR tenant_id = fintrace.current_tenant_id()) AND is_active
            """,
            [str(instrument_id)],
        )

    def find_instrument(self, symbol: str, currency_id: UUID) -> dict | None:
        return self.db.fetch_one(
            """
            SELECT id, symbol, name, currency_id FROM fintrace.investment_instruments
             WHERE lower(symbol) = lower(%s) AND currency_id = %s::uuid AND is_active
               AND (tenant_id IS NULL OR tenant_id = fintrace.current_tenant_id())
             ORDER BY tenant_id NULLS LAST, created_at
             LIMIT 1
            """,
            [symbol, str(currency_id)],
        )

    def create_instrument(self, tenant_id: UUID, symbol: str, name: str, instrument_type: str, currency_id: UUID) -> UUID:
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.investment_instruments (tenant_id, symbol, name, instrument_type, currency_id)
            VALUES (%s::uuid, %s, %s, %s, %s::uuid) RETURNING id
            """,
            [str(tenant_id), symbol, name, instrument_type, str(currency_id)],
        )

    def portfolio(self, portfolio_id: UUID) -> dict | None:
        return self.db.fetch_one(
            "SELECT id, name, currency_id FROM fintrace.investment_portfolios WHERE tenant_id = fintrace.current_tenant_id() AND id = %s::uuid AND is_active",
            [str(portfolio_id)],
        )

    def default_portfolio(self, tenant_id: UUID, currency_id: UUID) -> UUID:
        self.db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [f"fintrace.portfolio:{tenant_id}:{currency_id}"])
        row = self.db.fetch_one(
            """
            SELECT id FROM fintrace.investment_portfolios
             WHERE tenant_id = %s::uuid AND currency_id = %s::uuid AND is_active
             ORDER BY created_at LIMIT 1
            """,
            [str(tenant_id), str(currency_id)],
        )
        if row:
            return row["id"]
        return self.db.execute_returning_id(
            "INSERT INTO fintrace.investment_portfolios (tenant_id, name, currency_id) VALUES (%s::uuid, 'Main portfolio', %s::uuid) RETURNING id",
            [str(tenant_id), str(currency_id)],
        )

    def position(self, portfolio_id: UUID, instrument_id: UUID) -> dict | None:
        return self.db.fetch_one(
            """
            SELECT quantity, average_cost FROM fintrace.investment_positions
             WHERE tenant_id = fintrace.current_tenant_id() AND portfolio_id = %s::uuid AND instrument_id = %s::uuid
            """,
            [str(portfolio_id), str(instrument_id)],
        )

    def reversal_target(self, transaction_id: UUID) -> dict | None:
        """What a reversal of this transaction would also have to account for."""
        return self.db.fetch_one(
            """
            SELECT lt.id, lt.reverses_transaction_id IS NOT NULL AS is_reversal,
                   (SELECT x.debt_id FROM fintrace.debt_repayments x
                     WHERE x.tenant_id = lt.tenant_id AND x.ledger_transaction_id = lt.id) AS repaid_debt_id,
                   EXISTS (SELECT 1 FROM fintrace.investment_trades x
                            WHERE x.tenant_id = lt.tenant_id AND x.ledger_transaction_id = lt.id) AS is_trade,
                   EXISTS (SELECT 1 FROM fintrace.goal_contributions x
                            WHERE x.tenant_id = lt.tenant_id AND x.ledger_transaction_id = lt.id) AS is_goal_contribution
              FROM fintrace.ledger_transactions lt
             WHERE lt.tenant_id = fintrace.current_tenant_id() AND lt.id = %s::uuid
            """,
            [str(transaction_id)],
        )

    def reopen_debt(self, debt_id: UUID) -> None:
        self.db.execute("UPDATE fintrace.debts SET status = 'ACTIVE' WHERE id = %s::uuid AND status = 'PAID'", [str(debt_id)])

    # -- recurring ---------------------------------------------------------
    def recurring_for_update(self, recurring_id: UUID) -> dict | None:
        return self.db.fetch_one(
            """
            SELECT id, transaction_type, description, amount, currency_id, frequency, start_date, end_date,
                   next_run_at, is_active, source_account_id, destination_account_id, category_id
              FROM fintrace.recurring_transactions
             WHERE tenant_id = fintrace.current_tenant_id() AND id = %s::uuid
               FOR UPDATE
            """,
            [str(recurring_id)],
        )

    def record_occurrence(self, tenant_id: UUID, recurring_id: UUID, scheduled_for, status: str, ledger_transaction_id: UUID | None) -> UUID:
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.recurring_transaction_occurrences
                (tenant_id, recurring_transaction_id, scheduled_for, status, operation_id, ledger_transaction_id, attempt_count, executed_at)
            VALUES (%s::uuid, %s::uuid, %s, %s, gen_random_uuid(), %s::uuid, 1,
                    CASE WHEN %s = 'COMPLETED' THEN clock_timestamp() END)
            RETURNING id
            """,
            [str(tenant_id), str(recurring_id), scheduled_for, status, str(ledger_transaction_id) if ledger_transaction_id else None, status],
        )

    def advance_recurring(self, recurring_id: UUID, next_run_at, is_active: bool) -> None:
        self.db.execute(
            "UPDATE fintrace.recurring_transactions SET next_run_at = %s, is_active = %s WHERE id = %s::uuid",
            [next_run_at, is_active, str(recurring_id)],
        )

    # -- members -----------------------------------------------------------
    def user_by_email(self, email: str) -> dict | None:
        return self.db.fetch_one("SELECT id, username, email, status FROM fintrace.users WHERE lower(email) = lower(%s)", [email])

    def username_taken(self, username: str) -> bool:
        return self.db.fetch_one("SELECT 1 AS x FROM fintrace.users WHERE lower(username) = lower(%s)", [username]) is not None

    def create_user(self, username: str, email: str, password_hash: str, first_name: str, last_name: str) -> UUID:
        return self.db.execute_returning_id(
            "INSERT INTO fintrace.users (username, email, password_hash, first_name, last_name) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            [username, email, password_hash, first_name, last_name],
        )

    def membership(self, membership_id: UUID) -> dict | None:
        return self.db.fetch_one(
            """
            SELECT m.id, m.user_id, m.status, (t.owner_id = m.user_id) AS is_owner
              FROM fintrace.tenant_memberships m JOIN fintrace.tenants t ON t.id = m.tenant_id
             WHERE m.tenant_id = fintrace.current_tenant_id() AND m.id = %s::uuid
            """,
            [str(membership_id)],
        )

    def membership_for_user(self, user_id: UUID) -> dict | None:
        return self.db.fetch_one(
            "SELECT id, status FROM fintrace.tenant_memberships WHERE tenant_id = fintrace.current_tenant_id() AND user_id = %s::uuid",
            [str(user_id)],
        )

    def create_membership(self, tenant_id: UUID, user_id: UUID) -> UUID:
        return self.db.execute_returning_id(
            "INSERT INTO fintrace.tenant_memberships (tenant_id, user_id, status, joined_at) VALUES (%s::uuid, %s::uuid, 'ACTIVE', clock_timestamp()) RETURNING id",
            [str(tenant_id), str(user_id)],
        )

    def set_membership_status(self, membership_id: UUID, status: str) -> None:
        self.db.execute(
            "UPDATE fintrace.tenant_memberships SET status = %s, joined_at = COALESCE(joined_at, clock_timestamp()) WHERE id = %s::uuid",
            [status, str(membership_id)],
        )

    def set_system_role(self, membership_id: UUID, role_code: str) -> bool:
        role = self.db.fetch_one(
            "SELECT id FROM fintrace.rbac_roles WHERE tenant_id IS NULL AND is_system AND is_active AND code = %s", [role_code]
        )
        if role is None:
            return False
        self.db.execute(
            """
            DELETE FROM fintrace.rbac_membership_roles mr
             USING fintrace.rbac_roles r
             WHERE mr.membership_id = %s::uuid AND r.id = mr.role_id AND r.tenant_id IS NULL AND r.id <> %s::uuid
            """,
            [str(membership_id), str(role["id"])],
        )
        self.db.execute(
            "INSERT INTO fintrace.rbac_membership_roles (membership_id, role_id) VALUES (%s::uuid, %s::uuid) ON CONFLICT DO NOTHING",
            [str(membership_id), str(role["id"])],
        )
        return True
