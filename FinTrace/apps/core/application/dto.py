from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID


@dataclass(frozen=True)
class CurrencyDTO:
    id: UUID
    code: str
    name: str
    symbol: str
    decimal_places: int


@dataclass(frozen=True)
class TenantContextDTO:
    user_id: UUID
    tenant_id: UUID
    request_id: UUID | None = None
    client_ip: str | None = None
    user_agent: str | None = None


@dataclass(frozen=True)
class LedgerEntryDTO:
    account_id: UUID
    debit_amount: Decimal = Decimal("0")
    credit_amount: Decimal = Decimal("0")
    exchange_rate: Decimal = Decimal("1")


@dataclass(frozen=True)
class CreateLedgerTransactionDTO:
    occurred_at: datetime
    reference: str = ""
    description: str = ""
    entries: tuple[LedgerEntryDTO, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class CreateIncomeDTO:
    occurred_at: datetime
    occurred_on: date
    destination_account_id: UUID
    income_account_id: UUID
    category_id: UUID
    amount: Decimal
    currency_id: UUID
    contact_id: UUID | None = None
    reference: str = ""
    notes: str = ""


@dataclass(frozen=True)
class CreateExpenseDTO:
    occurred_at: datetime
    occurred_on: date
    source_account_id: UUID
    expense_account_id: UUID
    category_id: UUID
    amount: Decimal
    currency_id: UUID
    contact_id: UUID | None = None
    reference: str = ""
    notes: str = ""


@dataclass(frozen=True)
class CreateDebtRepaymentDTO:
    debt_id: UUID
    occurred_at: datetime
    repaid_on: date
    liability_account_id: UUID
    interest_expense_account_id: UUID | None
    cash_account_id: UUID
    principal_amount: Decimal
    interest_amount: Decimal = Decimal("0")
    reference: str = ""
    notes: str = ""
