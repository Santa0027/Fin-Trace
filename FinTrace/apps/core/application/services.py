from decimal import Decimal
from uuid import UUID

from FinTrace.apps.core.application.dto import (
    CreateDebtRepaymentDTO,
    CreateExpenseDTO,
    CreateIncomeDTO,
    CreateLedgerTransactionDTO,
    TenantContextDTO,
)
from FinTrace.apps.core.application.repository_interfaces import CurrencyRepository, FinancialMetadataRepository, LedgerRepository
from FinTrace.apps.core.domain.entities import Currency
from FinTrace.apps.core.infrastructure.database import context as db_context
from FinTrace.apps.core.infrastructure.repositories import ReportingRepository, TenantResourceRepository


class CurrencyService:
    def __init__(self, currency_repository: CurrencyRepository) -> None:
        self.currency_repository = currency_repository

    def list_active_currencies(self) -> list[Currency]:
        return self.currency_repository.list_active()

    def get_currency(self, code: str) -> Currency | None:
        return self.currency_repository.get_by_code(code.upper())


class TenantAwareService:
    def _tx(self, context: TenantContextDTO):
        return db_context.tenant_transaction(
            context.user_id,
            context.tenant_id,
            request_id=context.request_id,
            client_ip=context.client_ip,
            user_agent=context.user_agent,
        )


class LedgerService(TenantAwareService):
    def __init__(self, ledger_repository: LedgerRepository) -> None:
        self.ledger_repository = ledger_repository

    def list_transactions(self, context: TenantContextDTO, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.ledger_repository.list_transactions(limit, offset)

    def get_transaction(self, context: TenantContextDTO, transaction_id: UUID) -> dict | None:
        with self._tx(context):
            return self.ledger_repository.get_transaction(transaction_id)

    def create_transaction(self, context: TenantContextDTO, dto: CreateLedgerTransactionDTO) -> UUID:
        with self._tx(context):
            transaction_id = self.ledger_repository.create_transaction(dto.occurred_at, dto.reference, dto.description)
            for entry in dto.entries:
                self.ledger_repository.add_entry(transaction_id, entry.account_id, entry.debit_amount, entry.credit_amount, entry.exchange_rate)
            return transaction_id

    def add_entry(self, context: TenantContextDTO, transaction_id: UUID, account_id: UUID, debit_amount: Decimal, credit_amount: Decimal, exchange_rate: Decimal = Decimal("1")) -> UUID:
        with self._tx(context):
            return self.ledger_repository.add_entry(transaction_id, account_id, debit_amount, credit_amount, exchange_rate)

    def delete_entry(self, context: TenantContextDTO, entry_id: UUID) -> None:
        with self._tx(context):
            self.ledger_repository.delete_entry(entry_id)

    def post_transaction(self, context: TenantContextDTO, transaction_id: UUID) -> None:
        with self._tx(context):
            self.ledger_repository.post_transaction(transaction_id)

    def cancel_transaction(self, context: TenantContextDTO, transaction_id: UUID) -> None:
        with self._tx(context):
            self.ledger_repository.cancel_transaction(transaction_id)

    def reverse_transaction(self, context: TenantContextDTO, transaction_id: UUID, occurred_at, reference: str = "") -> UUID:
        with self._tx(context):
            return self.ledger_repository.reverse_transaction(context.tenant_id, transaction_id, occurred_at, reference)


class ResourceService(TenantAwareService):
    def __init__(self, repository: TenantResourceRepository) -> None:
        self.repository = repository

    def list(self, context: TenantContextDTO, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.repository.list(limit, offset)

    def get(self, context: TenantContextDTO, row_id: UUID) -> dict | None:
        with self._tx(context):
            return self.repository.get(row_id)

    def create(self, context: TenantContextDTO, payload: dict) -> UUID:
        with self._tx(context):
            return self.repository.create(context.tenant_id, payload)

    def update(self, context: TenantContextDTO, row_id: UUID, payload: dict) -> None:
        with self._tx(context):
            self.repository.update(row_id, payload)

    def archive(self, context: TenantContextDTO, row_id: UUID) -> None:
        with self._tx(context):
            self.repository.archive(row_id)


class IncomeService(TenantAwareService):
    def __init__(self, ledger_repository: LedgerRepository, metadata_repository: FinancialMetadataRepository) -> None:
        self.ledger_repository = ledger_repository
        self.metadata_repository = metadata_repository

    def list_income(self, context: TenantContextDTO, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.metadata_repository.list_income(limit, offset)

    def get_income(self, context: TenantContextDTO, income_id: UUID) -> dict | None:
        with self._tx(context):
            return self.metadata_repository.get_income(income_id)

    def create_income(self, context: TenantContextDTO, dto: CreateIncomeDTO) -> UUID:
        with self._tx(context):
            transaction_id = self.ledger_repository.create_transaction(dto.occurred_at, dto.reference, dto.notes)
            self.ledger_repository.add_entry(transaction_id, dto.destination_account_id, dto.amount, Decimal("0"))
            self.ledger_repository.add_entry(transaction_id, dto.income_account_id, Decimal("0"), dto.amount)
            self.ledger_repository.post_transaction(transaction_id)
            self.metadata_repository.create_income(context.tenant_id, transaction_id, dto.category_id, dto.contact_id, dto.amount, dto.currency_id, dto.occurred_on, dto.notes)
            return transaction_id


class ExpenseService(TenantAwareService):
    def __init__(self, ledger_repository: LedgerRepository, metadata_repository: FinancialMetadataRepository) -> None:
        self.ledger_repository = ledger_repository
        self.metadata_repository = metadata_repository

    def list_expenses(self, context: TenantContextDTO, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.metadata_repository.list_expenses(limit, offset)

    def get_expense(self, context: TenantContextDTO, expense_id: UUID) -> dict | None:
        with self._tx(context):
            return self.metadata_repository.get_expense(expense_id)

    def create_expense(self, context: TenantContextDTO, dto: CreateExpenseDTO) -> UUID:
        with self._tx(context):
            transaction_id = self.ledger_repository.create_transaction(dto.occurred_at, dto.reference, dto.notes)
            self.ledger_repository.add_entry(transaction_id, dto.expense_account_id, dto.amount, Decimal("0"))
            self.ledger_repository.add_entry(transaction_id, dto.source_account_id, Decimal("0"), dto.amount)
            self.ledger_repository.post_transaction(transaction_id)
            self.metadata_repository.create_expense(context.tenant_id, transaction_id, dto.category_id, dto.contact_id, dto.amount, dto.currency_id, dto.occurred_on, dto.notes)
            return transaction_id


class DebtService(TenantAwareService):
    def __init__(self, ledger_repository: LedgerRepository, metadata_repository: FinancialMetadataRepository) -> None:
        self.ledger_repository = ledger_repository
        self.metadata_repository = metadata_repository

    def create_repayment(self, context: TenantContextDTO, dto: CreateDebtRepaymentDTO) -> UUID:
        total = dto.principal_amount + dto.interest_amount
        with self._tx(context):
            transaction_id = self.ledger_repository.create_transaction(dto.occurred_at, dto.reference, dto.notes)
            if dto.principal_amount > 0:
                self.ledger_repository.add_entry(transaction_id, dto.liability_account_id, dto.principal_amount, Decimal("0"))
            if dto.interest_amount > 0:
                if dto.interest_expense_account_id is None:
                    raise ValueError("interest_expense_account_id is required when interest_amount is positive")
                self.ledger_repository.add_entry(transaction_id, dto.interest_expense_account_id, dto.interest_amount, Decimal("0"))
            self.ledger_repository.add_entry(transaction_id, dto.cash_account_id, Decimal("0"), total)
            self.ledger_repository.post_transaction(transaction_id)
            self.metadata_repository.create_debt_repayment(context.tenant_id, dto.debt_id, transaction_id, dto.principal_amount, dto.interest_amount, dto.repaid_on, dto.notes)
            return transaction_id


class ReportingService(TenantAwareService):
    def __init__(self, repository: ReportingRepository) -> None:
        self.repository = repository

    def list_report(self, context: TenantContextDTO, report_name: str, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.repository.list_view(report_name, limit, offset)

from datetime import datetime, timedelta, UTC
import hashlib
import json

from FinTrace.apps.core.infrastructure.repositories import (
    AuditRepository,
    HistoryRepository,
    IdempotencyRepository,
    InvestmentRepository,
    RBACRepository,
    RecurringRepository,
    TagAssociationRepository,
)


class RBACService(TenantAwareService):
    def __init__(self, repository: RBACRepository) -> None:
        self.repository = repository

    def list_pages(self, context: TenantContextDTO, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.repository.list_pages(limit, offset)

    def list_actions(self, context: TenantContextDTO, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.repository.list_actions(limit, offset)

    def list_permissions(self, context: TenantContextDTO, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.repository.list_permissions(limit, offset)

    def list_roles(self, context: TenantContextDTO, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.repository.list_roles(limit, offset)

    def create_role(self, context: TenantContextDTO, payload: dict) -> UUID:
        with self._tx(context):
            return self.repository.create_role(context.tenant_id, payload)

    def assign_permission(self, context: TenantContextDTO, role_id: UUID, payload: dict) -> None:
        with self._tx(context):
            self.repository.assign_permission(role_id, UUID(payload["permission_id"]), payload.get("access_scope", "TENANT"))

    def remove_permission(self, context: TenantContextDTO, role_id: UUID, permission_id: UUID) -> None:
        with self._tx(context):
            self.repository.remove_permission(role_id, permission_id)

    def assign_role(self, context: TenantContextDTO, membership_id: UUID, payload: dict) -> None:
        with self._tx(context):
            self.repository.assign_role(membership_id, UUID(payload["role_id"]))

    def remove_role(self, context: TenantContextDTO, membership_id: UUID, role_id: UUID) -> None:
        with self._tx(context):
            self.repository.remove_role(membership_id, role_id)

    def create_override(self, context: TenantContextDTO, membership_id: UUID, payload: dict) -> UUID:
        with self._tx(context):
            return self.repository.create_override(membership_id, UUID(payload["permission_id"]), payload["effect"], payload.get("access_scope", "TENANT"), payload.get("expires_at"))

    def remove_override(self, context: TenantContextDTO, override_id: UUID) -> None:
        with self._tx(context):
            self.repository.remove_override(override_id)

    def effective_permissions(self, context: TenantContextDTO) -> list[dict]:
        with self._tx(context):
            return self.repository.effective_permissions(context.user_id, context.tenant_id)


class TagService(TenantAwareService):
    def __init__(self, repository: TagAssociationRepository) -> None:
        self.repository = repository

    def list_income_tags(self, context: TenantContextDTO, income_id: UUID) -> list[dict]:
        with self._tx(context):
            return self.repository.list_income_tags(income_id)

    def add_income_tag(self, context: TenantContextDTO, income_id: UUID, tag_id: UUID) -> None:
        with self._tx(context):
            self.repository.add_income_tag(context.tenant_id, income_id, tag_id)

    def remove_income_tag(self, context: TenantContextDTO, income_id: UUID, tag_id: UUID) -> None:
        with self._tx(context):
            self.repository.remove_income_tag(income_id, tag_id)

    def list_expense_tags(self, context: TenantContextDTO, expense_id: UUID) -> list[dict]:
        with self._tx(context):
            return self.repository.list_expense_tags(expense_id)

    def add_expense_tag(self, context: TenantContextDTO, expense_id: UUID, tag_id: UUID) -> None:
        with self._tx(context):
            self.repository.add_expense_tag(context.tenant_id, expense_id, tag_id)

    def remove_expense_tag(self, context: TenantContextDTO, expense_id: UUID, tag_id: UUID) -> None:
        with self._tx(context):
            self.repository.remove_expense_tag(expense_id, tag_id)


class InvestmentService(TenantAwareService):
    def __init__(self, ledger_repository: LedgerRepository, investment_repository: InvestmentRepository) -> None:
        self.ledger_repository = ledger_repository
        self.investment_repository = investment_repository

    def create_trade(self, context: TenantContextDTO, payload: dict) -> UUID:
        quantity = Decimal(str(payload["quantity"]))
        price = Decimal(str(payload["price"]))
        fees = Decimal(str(payload.get("fees", "0")))
        gross = quantity * price
        trade_type = payload["trade_type"].upper()
        with self._tx(context):
            transaction_id = self.ledger_repository.create_transaction(datetime.fromisoformat(payload["occurred_at"]), payload.get("reference", ""), payload.get("notes", ""))
            if trade_type == "BUY":
                cash = gross + fees
                self.ledger_repository.add_entry(transaction_id, UUID(payload["investment_account_id"]), cash, Decimal("0"))
                self.ledger_repository.add_entry(transaction_id, UUID(payload["cash_account_id"]), Decimal("0"), cash)
            elif trade_type == "SELL":
                position = self.investment_repository.get_position(UUID(payload["portfolio_id"]), UUID(payload["instrument_id"]))
                if position is None:
                    raise ValueError("Cannot sell without an existing investment position")
                avg_cost = Decimal(str(position["average_cost"]))
                cash = gross - fees
                realized_pnl = (price - avg_cost) * quantity - fees
                cost_basis = cash - realized_pnl
                self.ledger_repository.add_entry(transaction_id, UUID(payload["cash_account_id"]), cash, Decimal("0"))
                self.ledger_repository.add_entry(transaction_id, UUID(payload["investment_account_id"]), Decimal("0"), cost_basis)
                pnl_account = UUID(payload["realized_pnl_account_id"])
                if realized_pnl > 0:
                    self.ledger_repository.add_entry(transaction_id, pnl_account, Decimal("0"), realized_pnl)
                elif realized_pnl < 0:
                    self.ledger_repository.add_entry(transaction_id, pnl_account, abs(realized_pnl), Decimal("0"))
            else:
                raise ValueError("trade_type must be BUY or SELL")
            self.ledger_repository.post_transaction(transaction_id)
            payload = {**payload, "trade_type": trade_type}
            return self.investment_repository.create_trade(context.tenant_id, payload, transaction_id)

    def create_dividend(self, context: TenantContextDTO, payload: dict) -> UUID:
        amount = Decimal(str(payload["amount"]))
        with self._tx(context):
            transaction_id = self.ledger_repository.create_transaction(datetime.fromisoformat(payload["occurred_at"]), payload.get("reference", ""), payload.get("notes", ""))
            self.ledger_repository.add_entry(transaction_id, UUID(payload["cash_account_id"]), amount, Decimal("0"))
            self.ledger_repository.add_entry(transaction_id, UUID(payload["income_account_id"]), Decimal("0"), amount)
            self.ledger_repository.post_transaction(transaction_id)
            return self.investment_repository.create_dividend(context.tenant_id, payload, transaction_id)


class AssetService(TenantAwareService):
    def __init__(self, repository: HistoryRepository) -> None:
        self.repository = repository

    def append_valuation(self, context: TenantContextDTO, asset_id: UUID, payload: dict) -> UUID:
        with self._tx(context):
            return self.repository.append_asset_valuation(context.tenant_id, asset_id, payload)

    def list_valuations(self, context: TenantContextDTO, asset_id: UUID, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.repository.list_asset_valuations(asset_id, limit, offset)


class GoalService(TenantAwareService):
    def __init__(self, ledger_repository: LedgerRepository, history_repository: HistoryRepository) -> None:
        self.ledger_repository = ledger_repository
        self.history_repository = history_repository

    def contribute(self, context: TenantContextDTO, goal_id: UUID, payload: dict) -> UUID:
        with self._tx(context):
            transaction_id = self.ledger_repository.create_transaction(datetime.fromisoformat(payload["occurred_at"]), payload.get("reference", ""), payload.get("notes", ""))
            for entry in payload.get("entries", []):
                self.ledger_repository.add_entry(transaction_id, UUID(entry["account_id"]), Decimal(str(entry.get("debit_amount", "0"))), Decimal(str(entry.get("credit_amount", "0"))), Decimal(str(entry.get("exchange_rate", "1"))))
            self.ledger_repository.post_transaction(transaction_id)
            return self.history_repository.create_goal_contribution(context.tenant_id, goal_id, payload, transaction_id)

    def list_contributions(self, context: TenantContextDTO, goal_id: UUID, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.history_repository.list_goal_contributions(goal_id, limit, offset)


class AuditService(TenantAwareService):
    def __init__(self, repository: AuditRepository) -> None:
        self.repository = repository

    def list_events(self, context: TenantContextDTO, filters: dict, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.repository.list_events(filters, limit, offset)

    def list_security_events(self, context: TenantContextDTO, filters: dict, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.repository.list_security_events(filters, limit, offset)

    def security_config_status(self, context: TenantContextDTO) -> dict | None:
        with self._tx(context):
            return self.repository.security_config_status()


class IdempotencyService(TenantAwareService):
    def __init__(self, repository: IdempotencyRepository) -> None:
        self.repository = repository

    def fingerprint(self, payload: dict) -> str:
        normalized = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def begin(self, context: TenantContextDTO, scope: str, key: str, payload: dict) -> dict:
        with self._tx(context):
            fingerprint = self.fingerprint(payload)
            op = self.repository.begin(context.tenant_id, context.user_id, scope, key, fingerprint, datetime.now(UTC) + timedelta(hours=24))
            if op["request_fingerprint"].lower() != fingerprint.lower():
                raise ValueError("IDEMPOTENCY_PAYLOAD_MISMATCH")
            if not op.get("is_new"):
                if op["status"] == "COMPLETED":
                    return {"reuse": True, "operation": op}
                if op["status"] == "PROCESSING":
                    raise ValueError("IDEMPOTENCY_OPERATION_PROCESSING")
                if op["status"] == "FAILED":
                    raise ValueError("IDEMPOTENCY_OPERATION_FAILED")
                if op["status"] == "EXPIRED":
                    raise ValueError("IDEMPOTENCY_KEY_EXPIRED")
            return {"reuse": False, "operation": op}

    def complete(self, context: TenantContextDTO, operation_id: UUID, business_operation_id: UUID | None, response_status: int, response_payload: dict) -> None:
        with self._tx(context):
            self.repository.complete(operation_id, business_operation_id, response_status, response_payload)

    def fail(self, context: TenantContextDTO, operation_id: UUID, reason: str) -> None:
        with self._tx(context):
            self.repository.fail(operation_id, reason)

    def prune_expired(self, batch_size: int = 5000) -> None:
        self.repository.prune_expired(batch_size)


class RecurringService(TenantAwareService):
    def __init__(self, repository: RecurringRepository, ledger_repository: LedgerRepository | None = None) -> None:
        self.repository = repository
        self.ledger_repository = ledger_repository

    def list_occurrences(self, context: TenantContextDTO, limit: int, offset: int) -> list[dict]:
        with self._tx(context):
            return self.repository.list_occurrences(limit, offset)

    def claim_due_occurrences(self, context: TenantContextDTO, batch_size: int) -> list[dict]:
        with self._tx(context):
            return self.repository.claim_due_occurrences(batch_size)

    def process_due_occurrences(self, context: TenantContextDTO, batch_size: int) -> list[dict]:
        if self.ledger_repository is None:
            raise ValueError("Ledger repository is required for recurring execution")
        results = []
        with self._tx(context):
            claimed = self.repository.claim_due_occurrences(batch_size)
            for occurrence in claimed:
                try:
                    definition = self.repository.get_definition_for_occurrence(occurrence["id"])
                    if definition["transaction_type"] != "TRANSFER":
                        raise ValueError("Recurring INCOME/EXPENSE requires configured counterpart accounts before execution")
                    tx_id = self.ledger_repository.create_transaction(datetime.combine(definition["scheduled_for"], datetime.min.time(), tzinfo=UTC), "", definition.get("description", ""))
                    amount = Decimal(str(definition["amount"]))
                    self.ledger_repository.add_entry(tx_id, definition["destination_account_id"], amount, Decimal("0"))
                    self.ledger_repository.add_entry(tx_id, definition["source_account_id"], Decimal("0"), amount)
                    self.ledger_repository.post_transaction(tx_id)
                    self.repository.complete_occurrence(occurrence["id"], tx_id)
                    results.append({"occurrence_id": occurrence["id"], "status": "COMPLETED", "ledger_transaction_id": tx_id})
                except Exception as exc:
                    self.repository.fail_occurrence(occurrence["id"], str(exc))
                    results.append({"occurrence_id": occurrence["id"], "status": "FAILED", "failure_reason": str(exc)})
            return results


class TenantService(ResourceService):
    def create(self, context: TenantContextDTO, payload: dict) -> UUID:
        return self.repository.provision_tenant(context.user_id, payload)


class MembershipService(ResourceService):
    pass


class AccountService(ResourceService):
    pass


class CategoryService(ResourceService):
    pass


class ContactService(ResourceService):
    pass


class SubscriptionService(ResourceService):
    pass
