from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from django.db import connection, transaction

from FinTrace.apps.core.application.repository_interfaces import CurrencyRepository, FinancialMetadataRepository, LedgerRepository
from FinTrace.apps.core.domain.entities import Currency
from FinTrace.apps.core.infrastructure.database.utils import DatabaseExecutor
from FinTrace.apps.core.infrastructure.models import CurrencyModel
from FinTrace.apps.core.infrastructure.sql import functions

import json


def json_dumps(value: dict) -> str:
    return json.dumps(value, sort_keys=True, default=str)


class DjangoCurrencyRepository(CurrencyRepository):
    def list_active(self) -> list[Currency]:
        return [self._to_entity(currency) for currency in CurrencyModel.objects.filter(is_active=True)]

    def get_by_code(self, code: str) -> Currency | None:
        currency = CurrencyModel.objects.filter(code=code).first()
        if currency is None:
            return None
        return self._to_entity(currency)

    def _to_entity(self, currency: CurrencyModel) -> Currency:
        return Currency(currency.id, currency.code, currency.name, currency.symbol, currency.decimal_places, currency.is_active)


class PostgreSQLLedgerRepository(LedgerRepository):
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def list_transactions(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all(
            """
            SELECT id, tenant_id, occurred_at, reference, description, status,
                   reverses_transaction_id, created_at, updated_at
              FROM fintrace.ledger_transactions
             ORDER BY occurred_at DESC, created_at DESC
             LIMIT %s OFFSET %s
            """,
            [limit, offset],
        )

    def get_transaction(self, transaction_id: UUID) -> dict | None:
        row = self.db.fetch_one(
            """
            SELECT id, tenant_id, occurred_at, reference, description, status,
                   reverses_transaction_id, created_at, updated_at
              FROM fintrace.ledger_transactions
             WHERE id = %s::uuid
            """,
            [str(transaction_id)],
        )
        if row:
            row["entries"] = self.db.fetch_all(
                """
                SELECT id, transaction_id, account_id, amount, debit_amount, credit_amount,
                       currency_id, exchange_rate, base_amount, created_at, updated_at
                  FROM fintrace.ledger_entries
                 WHERE transaction_id = %s::uuid
                 ORDER BY created_at, id
                """,
                [str(transaction_id)],
            )
        return row

    def create_transaction(self, occurred_at: datetime, reference: str = "", description: str = "") -> UUID:
        return self._fetch_uuid(functions.CREATE_LEDGER_TRANSACTION, [occurred_at, reference, description])

    def update_draft_transaction(self, transaction_id: UUID, occurred_at: datetime, reference: str, description: str) -> None:
        self._execute(functions.UPDATE_DRAFT_LEDGER_TRANSACTION, [str(transaction_id), occurred_at, reference, description])

    def add_entry(self, transaction_id: UUID, account_id: UUID, debit_amount: Decimal, credit_amount: Decimal, exchange_rate: Decimal = Decimal("1")) -> UUID:
        return self._fetch_uuid(functions.ADD_LEDGER_ENTRY, [str(transaction_id), str(account_id), debit_amount, credit_amount, exchange_rate])

    def delete_entry(self, entry_id: UUID) -> None:
        self._execute(functions.DELETE_LEDGER_ENTRY, [str(entry_id)])

    def post_transaction(self, transaction_id: UUID) -> None:
        self._execute(functions.POST_LEDGER_TRANSACTION, [str(transaction_id)])

    def cancel_transaction(self, transaction_id: UUID) -> None:
        self._execute(functions.CANCEL_LEDGER_TRANSACTION, [str(transaction_id)])

    def reverse_transaction(self, tenant_id: UUID, transaction_id: UUID, occurred_at: datetime, reference: str = "") -> UUID:
        return self._fetch_uuid(functions.REVERSE_LEDGER_TRANSACTION, [str(tenant_id), str(transaction_id), occurred_at, reference])

    def _fetch_uuid(self, sql: str, params: list[object]) -> UUID:
        with connection.cursor() as cursor:
            cursor.execute(sql, params)
            return cursor.fetchone()[0]

    def _execute(self, sql: str, params: list[object]) -> None:
        with connection.cursor() as cursor:
            cursor.execute(sql, params)


class PostgreSQLFinancialMetadataRepository(FinancialMetadataRepository):
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def list_income(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.income_records ORDER BY occurred_on DESC, created_at DESC LIMIT %s OFFSET %s", [limit, offset])

    def get_income(self, income_id: UUID) -> dict | None:
        return self.db.fetch_one("SELECT * FROM fintrace.income_records WHERE id = %s::uuid", [str(income_id)])

    def list_expenses(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.expense_records ORDER BY occurred_on DESC, created_at DESC LIMIT %s OFFSET %s", [limit, offset])

    def get_expense(self, expense_id: UUID) -> dict | None:
        return self.db.fetch_one("SELECT * FROM fintrace.expense_records WHERE id = %s::uuid", [str(expense_id)])

    def create_income(self, tenant_id: UUID, transaction_id: UUID, category_id: UUID, contact_id: UUID | None, amount: Decimal, currency_id: UUID, occurred_on: date, notes: str = "") -> UUID:
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.income_records
                (tenant_id, ledger_transaction_id, category_id, contact_id, amount, currency_id, occurred_on, notes)
            VALUES (%s::uuid, %s::uuid, %s::uuid, %s::uuid, %s, %s::uuid, %s, %s)
            RETURNING id
            """,
            [str(tenant_id), str(transaction_id), str(category_id), str(contact_id) if contact_id else None, amount, str(currency_id), occurred_on, notes],
        )

    def create_expense(self, tenant_id: UUID, transaction_id: UUID, category_id: UUID, contact_id: UUID | None, amount: Decimal, currency_id: UUID, occurred_on: date, notes: str = "") -> UUID:
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.expense_records
                (tenant_id, ledger_transaction_id, category_id, contact_id, amount, currency_id, occurred_on, notes)
            VALUES (%s::uuid, %s::uuid, %s::uuid, %s::uuid, %s, %s::uuid, %s, %s)
            RETURNING id
            """,
            [str(tenant_id), str(transaction_id), str(category_id), str(contact_id) if contact_id else None, amount, str(currency_id), occurred_on, notes],
        )

    def create_debt_repayment(self, tenant_id: UUID, debt_id: UUID, transaction_id: UUID, principal_amount: Decimal, interest_amount: Decimal, repaid_on: date, notes: str = "") -> UUID:
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.debt_repayments
                (tenant_id, debt_id, ledger_transaction_id, principal_amount, interest_amount, repaid_on, notes)
            VALUES (%s::uuid, %s::uuid, %s::uuid, %s, %s, %s, %s)
            RETURNING id
            """,
            [str(tenant_id), str(debt_id), str(transaction_id), principal_amount, interest_amount, repaid_on, notes],
        )


    def mark_debt_paid(self, debt_id: UUID) -> None:
        self.db.execute("UPDATE fintrace.debts SET status = 'PAID' WHERE id = %s::uuid AND status = 'ACTIVE'", [str(debt_id)])


class TenantResourceRepository:
    CONFIG = {
        "tenants": {
            "table": "fintrace.tenants",
            "columns": ["slug", "name", "owner_id", "base_currency_id", "status"],
            "update": ["name", "timezone"],
            "order": "created_at DESC",
            "tenant_column": "id",
        },
        "memberships": {
            "table": "fintrace.tenant_memberships",
            "columns": ["user_id", "status", "joined_at"],
            "update": ["status", "joined_at", "left_at"],
            "order": "created_at DESC",
        },
        "accounts": {
            "table": "fintrace.accounts",
            "columns": ["name", "type", "normal_balance", "institution", "account_number", "currency_id", "notes"],
            "update": ["name", "institution", "account_number", "notes", "is_active"],
            "order": "name ASC, created_at DESC",
            "archive": "UPDATE fintrace.accounts SET is_active = FALSE, archived_at = clock_timestamp() WHERE id = %s::uuid RETURNING id",
        },
        "categories": {
            "table": "fintrace.categories",
            "columns": ["name", "type", "parent_id"],
            "update": ["name", "parent_id", "is_active"],
            "order": "type ASC, name ASC",
            "archive": "UPDATE fintrace.categories SET is_active = FALSE, archived_at = clock_timestamp() WHERE id = %s::uuid RETURNING id",
        },
        "tags": {
            "table": "fintrace.tags",
            "columns": ["name", "color"],
            "update": ["name", "color", "is_active"],
            "order": "name ASC",
            "archive": "UPDATE fintrace.tags SET is_active = FALSE, archived_at = clock_timestamp() WHERE id = %s::uuid RETURNING id",
        },
        "contacts": {
            "table": "fintrace.contacts",
            "columns": ["name", "email", "phone", "notes"],
            "update": ["name", "email", "phone", "notes", "status"],
            "order": "name ASC, created_at DESC",
            "archive": "UPDATE fintrace.contacts SET status = 'ARCHIVED' WHERE id = %s::uuid RETURNING id",
        },
        "debts": {
            "table": "fintrace.debts",
            "columns": ["type", "contact_id", "principal_amount", "currency_id", "interest_rate", "start_date", "due_date", "notes"],
            "update": ["due_date", "status", "notes", "interest_rate"],
            "order": "created_at DESC",
        },
        "investment-portfolios": {
            "table": "fintrace.investment_portfolios",
            "columns": ["name", "currency_id", "broker"],
            "update": ["name", "broker", "is_active"],
            "order": "created_at DESC",
            "archive": "UPDATE fintrace.investment_portfolios SET is_active = FALSE, archived_at = clock_timestamp() WHERE id = %s::uuid RETURNING id",
        },
        "investment-instruments": {
            "table": "fintrace.investment_instruments",
            "columns": ["symbol", "name", "instrument_type", "currency_id", "exchange_code", "is_active"],
            "update": ["name", "exchange_code", "is_active"],
            "order": "symbol ASC",
            "tenant_nullable": True,
        },
        "assets": {
            "table": "fintrace.assets",
            "columns": ["name", "type", "purchase_value", "purchase_date", "currency_id", "notes"],
            "update": ["name", "notes"],
            "order": "created_at DESC",
            "archive": "UPDATE fintrace.assets SET archived_at = clock_timestamp() WHERE id = %s::uuid RETURNING id",
        },
        "goals": {
            "table": "fintrace.goals",
            "columns": ["name", "target_amount", "currency_id", "target_date", "priority", "notes"],
            "update": ["name", "target_date", "priority", "status", "notes"],
            "order": "priority DESC, created_at DESC",
        },
        "subscriptions": {
            "table": "fintrace.subscriptions",
            "columns": ["name", "amount", "currency_id", "frequency", "start_date", "next_billing_date", "end_date", "account_id", "category_id", "contact_id", "notes"],
            "update": ["name", "amount", "frequency", "next_billing_date", "end_date", "account_id", "category_id", "contact_id", "is_active", "notes"],
            "order": "next_billing_date ASC, created_at DESC",
        },
        "recurring-transactions": {
            "table": "fintrace.recurring_transactions",
            "columns": ["subscription_id", "transaction_type", "source_account_id", "destination_account_id", "amount", "currency_id", "category_id", "description", "frequency", "start_date", "end_date", "next_run_at", "timezone"],
            "update": ["description", "end_date", "next_run_at", "timezone", "is_active"],
            "order": "next_run_at ASC, created_at DESC",
        },
    }

    def __init__(self, resource: str) -> None:
        if resource not in self.CONFIG:
            raise ValueError(f"Unsupported resource {resource}")
        self.resource = resource
        self.config = self.CONFIG[resource]
        self.db = DatabaseExecutor()

    def list(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all(f"SELECT * FROM {self.config['table']} ORDER BY {self.config['order']} LIMIT %s OFFSET %s", [limit, offset])

    def get(self, row_id: UUID) -> dict | None:
        return self.db.fetch_one(f"SELECT * FROM {self.config['table']} WHERE id = %s::uuid", [str(row_id)])

    def create(self, tenant_id: UUID, payload: dict) -> UUID:
        self._reject_unknown_fields(payload, self.config["columns"])
        columns = [column for column in self.config["columns"] if column in payload]
        sql_columns = [] if self.config.get("tenant_column") == "id" else ["tenant_id"]
        sql_columns.extend(columns)
        placeholders = [] if self.config.get("tenant_column") == "id" else ["%s::uuid"]
        placeholders.extend([self._placeholder(column) for column in columns])
        values = [] if self.config.get("tenant_column") == "id" else [str(tenant_id)]
        values.extend([payload[column] for column in columns])
        sql = f"INSERT INTO {self.config['table']} ({', '.join(sql_columns)}) VALUES ({', '.join(placeholders)}) RETURNING id"
        return self.db.execute_returning_id(sql, values)

    def provision_tenant(self, user_id: UUID, payload: dict) -> UUID:
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT fintrace.provision_tenant(%s::uuid, %s, %s, %s::uuid)",
                    [str(user_id), payload["slug"], payload["name"], str(payload["base_currency_id"])],
                )
                return cursor.fetchone()[0]

    def update(self, row_id: UUID, payload: dict) -> None:
        self._reject_unknown_fields(payload, self.config["update"])
        columns = [column for column in self.config["update"] if column in payload]
        if not columns:
            return
        assignments = [f"{column} = {self._placeholder(column)}" for column in columns]
        values = [payload[column] for column in columns]
        if payload.get("is_active") is True and "archived_at" in self.config.get("archive", ""):
            assignments.append("archived_at = NULL")  # restoring undoes the archive
        self.db.execute(f"UPDATE {self.config['table']} SET {', '.join(assignments)} WHERE id = %s::uuid", [*values, str(row_id)])

    def archive(self, row_id: UUID) -> None:
        sql = self.config.get("archive")
        if not sql:
            raise ValueError(f"{self.resource} does not support archive")
        self.db.execute(sql, [str(row_id)])

    def _placeholder(self, column: str) -> str:
        if column.endswith("_id") or column == "currency_id":
            return "%s::uuid"
        return "%s"

    def _reject_unknown_fields(self, payload: dict, allowed_fields: list[str]) -> None:
        unknown = sorted(set(payload) - set(allowed_fields))
        if unknown:
            raise ValueError(f"Unsupported field(s) for {self.resource}: {', '.join(unknown)}")


class RBACRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def list_pages(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.rbac_pages ORDER BY code LIMIT %s OFFSET %s", [limit, offset])

    def list_actions(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.rbac_actions ORDER BY code LIMIT %s OFFSET %s", [limit, offset])

    def list_permissions(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.rbac_permissions ORDER BY code LIMIT %s OFFSET %s", [limit, offset])

    def list_roles(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.rbac_roles ORDER BY is_system DESC, code LIMIT %s OFFSET %s", [limit, offset])

    def create_role(self, tenant_id: UUID, payload: dict) -> UUID:
        return self.db.execute_returning_id(
            "INSERT INTO fintrace.rbac_roles (tenant_id, code, name, description) VALUES (%s::uuid, %s, %s, %s) RETURNING id",
            [str(tenant_id), payload["code"], payload["name"], payload.get("description", "")],
        )

    def assign_permission(self, role_id: UUID, permission_id: UUID, access_scope: str = "TENANT") -> None:
        self.db.execute(
            "INSERT INTO fintrace.rbac_role_permissions (role_id, permission_id, access_scope) VALUES (%s::uuid, %s::uuid, %s) ON CONFLICT (role_id, permission_id) DO UPDATE SET access_scope = EXCLUDED.access_scope",
            [str(role_id), str(permission_id), access_scope],
        )

    def remove_permission(self, role_id: UUID, permission_id: UUID) -> None:
        self.db.execute("DELETE FROM fintrace.rbac_role_permissions WHERE role_id = %s::uuid AND permission_id = %s::uuid", [str(role_id), str(permission_id)])

    def assign_role(self, membership_id: UUID, role_id: UUID) -> None:
        self.db.execute("INSERT INTO fintrace.rbac_membership_roles (membership_id, role_id) VALUES (%s::uuid, %s::uuid) ON CONFLICT DO NOTHING", [str(membership_id), str(role_id)])

    def remove_role(self, membership_id: UUID, role_id: UUID) -> None:
        self.db.execute("DELETE FROM fintrace.rbac_membership_roles WHERE membership_id = %s::uuid AND role_id = %s::uuid", [str(membership_id), str(role_id)])

    def create_override(self, membership_id: UUID, permission_id: UUID, effect: str, access_scope: str = "TENANT", expires_at=None) -> UUID:
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.rbac_user_permission_overrides (membership_id, permission_id, effect, access_scope, expires_at)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s)
            ON CONFLICT (membership_id, permission_id)
            DO UPDATE SET effect = EXCLUDED.effect, access_scope = EXCLUDED.access_scope, expires_at = EXCLUDED.expires_at
            RETURNING id
            """,
            [str(membership_id), str(permission_id), effect, access_scope, expires_at],
        )

    def remove_override(self, override_id: UUID) -> None:
        self.db.execute("DELETE FROM fintrace.rbac_user_permission_overrides WHERE id = %s::uuid", [str(override_id)])

    def effective_permissions(self, user_id: UUID, tenant_id: UUID) -> list[dict]:
        return self.db.fetch_all(
            """
            SELECT p.code, COALESCE(o.effect, 'ALLOW') AS effect, COALESCE(o.access_scope, rp.access_scope) AS access_scope
              FROM fintrace.tenant_memberships m
              JOIN fintrace.rbac_membership_roles mr ON mr.membership_id = m.id
              JOIN fintrace.rbac_role_permissions rp ON rp.role_id = mr.role_id
              JOIN fintrace.rbac_permissions p ON p.id = rp.permission_id
              LEFT JOIN fintrace.rbac_user_permission_overrides o ON o.membership_id = m.id AND o.permission_id = p.id
             WHERE m.user_id = %s::uuid AND m.tenant_id = %s::uuid AND m.status = 'ACTIVE'
             ORDER BY p.code
            """,
            [str(user_id), str(tenant_id)],
        )


class TagAssociationRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def list_income_tags(self, income_id: UUID) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.income_tags WHERE income_id = %s::uuid ORDER BY created_at", [str(income_id)])

    def add_income_tag(self, tenant_id: UUID, income_id: UUID, tag_id: UUID) -> None:
        self.db.execute("INSERT INTO fintrace.income_tags (tenant_id, income_id, tag_id) VALUES (%s::uuid, %s::uuid, %s::uuid) ON CONFLICT DO NOTHING", [str(tenant_id), str(income_id), str(tag_id)])

    def remove_income_tag(self, income_id: UUID, tag_id: UUID) -> None:
        self.db.execute("DELETE FROM fintrace.income_tags WHERE income_id = %s::uuid AND tag_id = %s::uuid", [str(income_id), str(tag_id)])

    def list_expense_tags(self, expense_id: UUID) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.expense_tags WHERE expense_id = %s::uuid ORDER BY created_at", [str(expense_id)])

    def add_expense_tag(self, tenant_id: UUID, expense_id: UUID, tag_id: UUID) -> None:
        self.db.execute("INSERT INTO fintrace.expense_tags (tenant_id, expense_id, tag_id) VALUES (%s::uuid, %s::uuid, %s::uuid) ON CONFLICT DO NOTHING", [str(tenant_id), str(expense_id), str(tag_id)])

    def remove_expense_tag(self, expense_id: UUID, tag_id: UUID) -> None:
        self.db.execute("DELETE FROM fintrace.expense_tags WHERE expense_id = %s::uuid AND tag_id = %s::uuid", [str(expense_id), str(tag_id)])


class InvestmentRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def get_position(self, portfolio_id: UUID, instrument_id: UUID) -> dict | None:
        return self.db.fetch_one("SELECT * FROM fintrace.investment_positions WHERE portfolio_id = %s::uuid AND instrument_id = %s::uuid", [str(portfolio_id), str(instrument_id)])

    def create_trade(self, tenant_id: UUID, payload: dict, ledger_transaction_id: UUID) -> UUID:
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.investment_trades
                (tenant_id, portfolio_id, instrument_id, ledger_transaction_id, trade_type, quantity, price, fees, traded_at, cash_account_id, investment_account_id, realized_pnl_account_id)
            VALUES (%s::uuid, %s::uuid, %s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s::uuid, %s::uuid, %s::uuid)
            RETURNING id
            """,
            [str(tenant_id), payload["portfolio_id"], payload["instrument_id"], str(ledger_transaction_id), payload["trade_type"], payload["quantity"], payload["price"], payload.get("fees", 0), payload["traded_at"], payload["cash_account_id"], payload["investment_account_id"], payload.get("realized_pnl_account_id")],
        )

    def create_dividend(self, tenant_id: UUID, payload: dict, ledger_transaction_id: UUID) -> UUID:
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.investment_dividends
                (tenant_id, portfolio_id, instrument_id, ledger_transaction_id, amount, currency_id, paid_on, notes, cash_account_id, income_account_id)
            VALUES (%s::uuid, %s::uuid, %s::uuid, %s::uuid, %s, %s::uuid, %s, %s, %s::uuid, %s::uuid)
            RETURNING id
            """,
            [str(tenant_id), payload["portfolio_id"], payload["instrument_id"], str(ledger_transaction_id), payload["amount"], payload["currency_id"], payload["paid_on"], payload.get("notes", ""), payload["cash_account_id"], payload["income_account_id"]],
        )


class HistoryRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def append_asset_valuation(self, tenant_id: UUID, asset_id: UUID, payload: dict) -> UUID:
        return self.db.execute_returning_id(
            "INSERT INTO fintrace.asset_valuations (tenant_id, asset_id, value, currency_id, valued_on, source, notes) VALUES (%s::uuid, %s::uuid, %s, %s::uuid, %s, %s, %s) RETURNING id",
            [str(tenant_id), str(asset_id), payload["value"], payload["currency_id"], payload["valued_on"], payload.get("source", "MANUAL"), payload.get("notes", "")],
        )

    def list_asset_valuations(self, asset_id: UUID, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.asset_valuations WHERE asset_id = %s::uuid ORDER BY valued_on DESC, created_at DESC LIMIT %s OFFSET %s", [str(asset_id), limit, offset])

    def create_goal_contribution(self, tenant_id: UUID, goal_id: UUID, payload: dict, ledger_transaction_id: UUID) -> UUID:
        return self.db.execute_returning_id(
            "INSERT INTO fintrace.goal_contributions (tenant_id, goal_id, ledger_transaction_id, amount, currency_id, contributed_on, notes) VALUES (%s::uuid, %s::uuid, %s::uuid, %s, %s::uuid, %s, %s) RETURNING id",
            [str(tenant_id), str(goal_id), str(ledger_transaction_id), payload["amount"], payload["currency_id"], payload["contributed_on"], payload.get("notes", "")],
        )

    def list_goal_contributions(self, goal_id: UUID, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.goal_contributions WHERE goal_id = %s::uuid ORDER BY contributed_on DESC, created_at DESC LIMIT %s OFFSET %s", [str(goal_id), limit, offset])


class AuditRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def list_events(self, filters: dict, limit: int, offset: int) -> list[dict]:
        where = []
        params: list[object] = []
        for field in ["actor_user_id", "action", "entity_type", "entity_id", "request_id"]:
            if filters.get(field):
                cast = "::uuid" if field.endswith("_id") or field == "request_id" else ""
                where.append(f"{field} = %s{cast}")
                params.append(str(filters[field]) if cast else filters[field])
        if filters.get("date_from"):
            where.append("occurred_at >= %s")
            params.append(filters["date_from"])
        if filters.get("date_to"):
            where.append("occurred_at <= %s")
            params.append(filters["date_to"])
        sql_where = "WHERE " + " AND ".join(where) if where else ""
        return self.db.fetch_all(f"SELECT * FROM fintrace.audit_events {sql_where} ORDER BY occurred_at DESC LIMIT %s OFFSET %s", [*params, limit, offset])

    def list_security_events(self, filters: dict, limit: int, offset: int) -> list[dict]:
        where = []
        params: list[object] = []
        for field in ["actor_user_id", "subject_user_id", "action", "request_id"]:
            if filters.get(field):
                cast = "::uuid" if field.endswith("_id") or field == "request_id" else ""
                where.append(f"{field} = %s{cast}")
                params.append(str(filters[field]) if cast else filters[field])
        sql_where = "WHERE " + " AND ".join(where) if where else ""
        return self.db.fetch_all(f"SELECT id, actor_user_id, subject_user_id, action, before_data, after_data, request_id, database_user, occurred_at FROM fintrace.security_audit_events {sql_where} ORDER BY occurred_at DESC LIMIT %s OFFSET %s", [*params, limit, offset])

    def security_config_status(self) -> dict | None:
        # The secret column is NOT NULL and deliberately unreadable by runtime roles.
        return self.db.fetch_one("SELECT singleton, created_at, TRUE AS has_context_hmac_secret FROM fintrace.security_config WHERE singleton = TRUE")


class IdempotencyRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def begin(self, tenant_id: UUID, user_id: UUID, scope: str, key: str, fingerprint: str, expires_at) -> dict:
        """Claim the key, or return the row that already holds it.

        The insert waits on a concurrent uncommitted claim of the same key, so a
        duplicate request blocks until the first one commits (and then replays its
        response) or rolls back (and then proceeds as the first attempt).
        """
        created = self.db.fetch_one(
            """
            INSERT INTO fintrace.idempotency_operations (tenant_id, user_id, operation_scope, operation_key, request_fingerprint, expires_at)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, operation_scope, operation_key) DO NOTHING
            RETURNING *
            """,
            [str(tenant_id), str(user_id), scope, key, fingerprint, expires_at],
        )
        if created is not None:
            created["is_new"] = True
            return created
        existing = self.db.fetch_one(
            """
            SELECT * FROM fintrace.idempotency_operations
             WHERE tenant_id = %s::uuid AND operation_scope = %s AND operation_key = %s
             FOR UPDATE
            """,
            [str(tenant_id), scope, key],
        )
        if existing is None:
            raise RuntimeError("Idempotency key is held by an operation that is not visible to this tenant context")
        existing["is_new"] = False
        return existing

    def restart(self, operation_id: UUID, expires_at) -> None:
        self.db.execute(
            """
            UPDATE fintrace.idempotency_operations
               SET status = 'PROCESSING', failure_reason = '', failed_at = NULL, expires_at = %s
             WHERE id = %s::uuid
            """,
            [expires_at, str(operation_id)],
        )

    def complete(self, operation_id: UUID, business_operation_id: UUID | None, response_status: int, response_payload: dict) -> None:
        self.db.execute(
            """
            UPDATE fintrace.idempotency_operations
               SET status = 'COMPLETED', operation_id = %s::uuid, response_status = %s,
                   response_payload = %s, completed_at = clock_timestamp(), failure_reason = ''
             WHERE id = %s::uuid
            """,
            [str(business_operation_id) if business_operation_id else None, response_status, json_dumps(response_payload), str(operation_id)],
        )

    def fail(self, operation_id: UUID, reason: str) -> None:
        self.db.execute("UPDATE fintrace.idempotency_operations SET status = 'FAILED', failure_reason = %s, failed_at = clock_timestamp() WHERE id = %s::uuid", [reason[:1000], str(operation_id)])

    def expire(self, operation_id: UUID) -> None:
        self.db.execute("UPDATE fintrace.idempotency_operations SET status = 'EXPIRED' WHERE id = %s::uuid", [str(operation_id)])

    def prune_expired(self, batch_size: int = 5000) -> None:
        with connection.cursor() as cursor:
            cursor.execute("CALL fintrace.prune_expired_idempotency_operations(%s)", [batch_size])


class RecurringRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def list_occurrences(self, limit: int, offset: int) -> list[dict]:
        return self.db.fetch_all("SELECT * FROM fintrace.recurring_transaction_occurrences ORDER BY scheduled_for ASC, created_at ASC LIMIT %s OFFSET %s", [limit, offset])

    def claim_due_occurrences(self, batch_size: int) -> list[dict]:
        return self.db.fetch_all(
            """
            WITH due AS (
                SELECT id FROM fintrace.recurring_transaction_occurrences
                 WHERE (status = 'PENDING' OR (status = 'PROCESSING' AND locked_until < clock_timestamp()))
                   AND scheduled_for <= CURRENT_DATE
                 ORDER BY scheduled_for, created_at
                 LIMIT %s
                 FOR UPDATE SKIP LOCKED
            )
            UPDATE fintrace.recurring_transaction_occurrences o
               SET status = 'PROCESSING', attempt_count = attempt_count + 1, locked_until = clock_timestamp() + interval '15 minutes'
              FROM due
             WHERE o.id = due.id
             RETURNING o.*
            """,
            [batch_size],
        )

    def get_definition_for_occurrence(self, occurrence_id: UUID) -> dict | None:
        return self.db.fetch_one(
            """
            SELECT o.*, rt.transaction_type, rt.source_account_id, rt.destination_account_id,
                   rt.amount, rt.currency_id, rt.description
              FROM fintrace.recurring_transaction_occurrences o
              JOIN fintrace.recurring_transactions rt ON rt.tenant_id = o.tenant_id AND rt.id = o.recurring_transaction_id
             WHERE o.id = %s::uuid
            """,
            [str(occurrence_id)],
        )

    def complete_occurrence(self, occurrence_id: UUID, ledger_transaction_id: UUID) -> None:
        self.db.execute(
            """
            UPDATE fintrace.recurring_transaction_occurrences
               SET status = 'COMPLETED', ledger_transaction_id = %s::uuid,
                   executed_at = clock_timestamp(), locked_until = NULL, failure_reason = ''
             WHERE id = %s::uuid
            """,
            [str(ledger_transaction_id), str(occurrence_id)],
        )

    def fail_occurrence(self, occurrence_id: UUID, reason: str) -> None:
        self.db.execute("UPDATE fintrace.recurring_transaction_occurrences SET status = 'FAILED', failure_reason = %s, locked_until = NULL WHERE id = %s::uuid", [reason[:1000], str(occurrence_id)])


class ReportingRepository:
    VIEWS = {
        "account-balances": "fintrace.account_balances",
        "debt-balances": "fintrace.debt_balances",
        "goal-progress": "fintrace.goal_progress",
        "asset-current-valuations": "fintrace.asset_current_valuations",
        "investment-position-summary": "fintrace.investment_position_summary",
        "unbalanced-transactions": "fintrace.unbalanced_transactions",
        "data-integrity-issues": "fintrace.data_integrity_issues",
        "tenant-users": "fintrace.tenant_users",
    }

    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def list_view(self, view_name: str, limit: int, offset: int) -> list[dict]:
        if view_name not in self.VIEWS:
            raise ValueError(f"Unsupported report {view_name}")
        return self.db.fetch_all(f"SELECT * FROM {self.VIEWS[view_name]} LIMIT %s OFFSET %s", [limit, offset])
