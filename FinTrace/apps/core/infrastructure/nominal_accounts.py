"""System-managed counterpart accounts.

People record "income into my bank account"; the ledger needs a second side.
These accounts supply it. They are found (or created once) per tenant and
currency, flagged ``is_system`` so the product can keep them out of account
pickers and refuse edits that would detach them.
"""
from uuid import UUID

from FinTrace.apps.core.infrastructure.database.utils import DatabaseExecutor

# key -> (name, account type, normal balance)
NOMINAL_ACCOUNTS = {
    "INCOME": ("Income", "INCOME", "CREDIT"),
    "EXPENSE": ("Expenses", "EXPENSE", "DEBIT"),
    "OPENING": ("Opening balances", "EQUITY", "CREDIT"),
    "LOANS_PAYABLE": ("Loans payable", "LIABILITY", "CREDIT"),
    "LOANS_RECEIVABLE": ("Loans receivable", "OTHER", "DEBIT"),
    "INVESTMENTS": ("Investment holdings", "INVESTMENT", "DEBIT"),
}


class NominalAccountRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def get_or_create(self, tenant_id: UUID, key: str, currency_id: UUID) -> UUID:
        name, account_type, normal_balance = NOMINAL_ACCOUNTS[key]
        # Serialise first use so two concurrent requests cannot create two accounts.
        self.db.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            [f"fintrace.nominal:{tenant_id}:{key}:{currency_id}"],
        )
        row = self.db.fetch_one(
            """
            SELECT id FROM fintrace.accounts
             WHERE tenant_id = %s::uuid AND is_system AND is_active
               AND type = %s AND name = %s AND currency_id = %s::uuid
             ORDER BY created_at
             LIMIT 1
            """,
            [str(tenant_id), account_type, name, str(currency_id)],
        )
        if row:
            return row["id"]
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.accounts (tenant_id, name, type, normal_balance, currency_id, is_system, notes)
            VALUES (%s::uuid, %s, %s, %s, %s::uuid, TRUE, 'Managed by FinTrace')
            RETURNING id
            """,
            [str(tenant_id), name, account_type, normal_balance, str(currency_id)],
        )
