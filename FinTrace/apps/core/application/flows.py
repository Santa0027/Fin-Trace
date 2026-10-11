"""Human-level financial flows.

Callers describe what happened in everyday terms ("paid 1,500 for food from my
bank account"). This module validates that, resolves the accounting
counterpart, and hands a fully specified posting to the ledger services. Nothing
here writes balances: every effect goes through the ledger routines.

All public methods must be called inside a tenant transaction (see
``TenantAwareService._tx``); the API views do this through the idempotency wrapper.
"""
import calendar
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID

from FinTrace.apps.core.application.dto import CreateDebtRepaymentDTO, CreateExpenseDTO, CreateIncomeDTO, TenantContextDTO
from FinTrace.apps.core.application.services import DebtService, ExpenseService, IncomeService, InvestmentService, LedgerService, TenantAwareService
from FinTrace.apps.core.domain.exceptions import Conflict, NotFound, ValidationFailed
from FinTrace.apps.core.infrastructure.flow_repository import FlowRepository
from FinTrace.apps.core.infrastructure.nominal_accounts import NominalAccountRepository
from FinTrace.apps.core.infrastructure.repositories import InvestmentRepository, PostgreSQLFinancialMetadataRepository, PostgreSQLLedgerRepository
from FinTrace.apps.core.application.parsing import business_datetime, clean_text, local_today, parse_amount, parse_date, parse_occurrence, parse_uuid

INSTRUMENT_TYPES = {"STOCK", "ETF", "MUTUAL_FUND", "BOND", "CRYPTO", "FOREX", "OTHER"}


def _first(payload: dict, *names: str):
    for name in names:
        if payload.get(name) not in (None, ""):
            return name
    return names[0]


def _quantize(value: Decimal, decimals: int) -> Decimal:
    return value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


class FinancialFlows(TenantAwareService):
    def __init__(self) -> None:
        self.lookup = FlowRepository()
        self.nominal = NominalAccountRepository()
        self.ledger_repository = PostgreSQLLedgerRepository()
        self.metadata_repository = PostgreSQLFinancialMetadataRepository()
        self.ledger = LedgerService(self.ledger_repository)
        self._timezone: str | None = None

    @property
    def timezone(self) -> str:
        if self._timezone is None:
            self._timezone = self.lookup.timezone()
        return self._timezone

    # -- shared validation -------------------------------------------------
    def _payment_account(self, payload: dict, field: str, label: str) -> dict:
        account_id = parse_uuid(payload, field, label=f"the {label} account")
        account = self.lookup.account(account_id)
        if account is None:
            raise ValidationFailed({field: f"The {label} account was not found in this workspace."})
        if not account["is_active"]:
            raise ValidationFailed({field: f"{account['name']} is archived. Choose an active account."}, code="ACCOUNT_INACTIVE")
        if account["is_system"] or account["type"] in {"INCOME", "EXPENSE", "EQUITY"}:
            raise ValidationFailed({field: f"{account['name']} cannot be used to pay or receive money."})
        return account

    def _exchange_rate(self, payload: dict, currency_id: UUID) -> Decimal:
        base = self.lookup.base_currency()
        if currency_id == base["id"]:
            return Decimal("1")
        if payload.get("exchange_rate") in (None, ""):
            raise ValidationFailed(
                {"exchange_rate": f"This account is not in {base['code']}. Enter the exchange rate to {base['code']}."},
                code="EXCHANGE_RATE_REQUIRED",
            )
        rate = parse_amount(payload, "exchange_rate")
        if rate == 1:
            raise ValidationFailed({"exchange_rate": "The exchange rate for a foreign-currency account cannot be 1."})
        return rate

    def _category(self, payload: dict, expected_type: str) -> dict:
        category_id = parse_uuid(payload, "category_id", label="a category")
        category = self.lookup.category(category_id)
        if category is None:
            raise ValidationFailed({"category_id": "The category was not found in this workspace."})
        if not category["is_active"]:
            raise ValidationFailed({"category_id": f"{category['name']} is archived. Choose an active category."})
        if category["type"] != expected_type:
            raise ValidationFailed({"category_id": f"{category['name']} is not {'an income' if expected_type == 'INCOME' else 'an expense'} category."})
        return category

    def _contact_id(self, payload: dict) -> UUID | None:
        contact_id = parse_uuid(payload, "contact_id", required=False)
        if contact_id and self.lookup.contact(contact_id) is None:
            raise ValidationFailed({"contact_id": "The contact was not found in this workspace."})
        return contact_id

    def _check_currency(self, payload: dict, account: dict, field: str) -> None:
        supplied = parse_uuid(payload, "currency_id", required=False)
        if supplied and supplied != account["currency_id"]:
            raise ValidationFailed({field: f"{account['name']} uses a different currency."}, code="CURRENCY_MISMATCH")

    # -- income / expense / transfer --------------------------------------
    def record_income(self, context: TenantContextDTO, payload: dict) -> tuple[dict, UUID]:
        amount = parse_amount(payload)
        occurred_at, occurred_on = parse_occurrence(payload, timezone=self.timezone)
        account = self._payment_account(payload, "destination_account_id", "received into")
        self._check_currency(payload, account, "destination_account_id")
        category = self._category(payload, "INCOME")
        income_account_id = parse_uuid(payload, "income_account_id", required=False) or self.nominal.get_or_create(
            context.tenant_id, "INCOME", account["currency_id"]
        )
        notes = clean_text(payload, "notes", 2000)
        dto = CreateIncomeDTO(
            occurred_at=occurred_at, occurred_on=occurred_on,
            destination_account_id=account["id"], income_account_id=income_account_id,
            category_id=category["id"], amount=amount, currency_id=account["currency_id"],
            contact_id=self._contact_id(payload), reference=clean_text(payload, "reference"), notes=notes,
            exchange_rate=self._exchange_rate(payload, account["currency_id"]),
        )
        transaction_id, income_id = IncomeService(self.ledger_repository, self.metadata_repository).create_income(
            context, dto, notes or f"{category['name']} income"
        )
        return {"id": str(income_id), "ledger_transaction_id": str(transaction_id)}, transaction_id

    def record_expense(self, context: TenantContextDTO, payload: dict) -> tuple[dict, UUID]:
        amount = parse_amount(payload)
        occurred_at, occurred_on = parse_occurrence(payload, timezone=self.timezone)
        account = self._payment_account(payload, "source_account_id", "paid from")
        self._check_currency(payload, account, "source_account_id")
        category = self._category(payload, "EXPENSE")
        expense_account_id = parse_uuid(payload, "expense_account_id", required=False) or self.nominal.get_or_create(
            context.tenant_id, "EXPENSE", account["currency_id"]
        )
        notes = clean_text(payload, "notes", 2000)
        dto = CreateExpenseDTO(
            occurred_at=occurred_at, occurred_on=occurred_on,
            source_account_id=account["id"], expense_account_id=expense_account_id,
            category_id=category["id"], amount=amount, currency_id=account["currency_id"],
            contact_id=self._contact_id(payload), reference=clean_text(payload, "reference"), notes=notes,
            exchange_rate=self._exchange_rate(payload, account["currency_id"]),
        )
        transaction_id, expense_id = ExpenseService(self.ledger_repository, self.metadata_repository).create_expense(
            context, dto, notes or f"{category['name']} expense"
        )
        return {"id": str(expense_id), "ledger_transaction_id": str(transaction_id)}, transaction_id

    def transfer(self, context: TenantContextDTO, payload: dict) -> tuple[dict, UUID]:
        amount = parse_amount(payload)
        occurred_at, _ = parse_occurrence(payload, timezone=self.timezone)
        source_field = _first(payload, "from_account_id", "source_account_id")
        destination_field = _first(payload, "to_account_id", "destination_account_id")
        source = self._payment_account(payload, source_field, "from")
        destination = self._payment_account(payload, destination_field, "to")
        if source["id"] == destination["id"]:
            raise ValidationFailed({destination_field: "Choose two different accounts to transfer between."}, code="SAME_ACCOUNT")
        note = clean_text(payload, "description") or clean_text(payload, "notes")
        description = f"Transfer: {source['name']} → {destination['name']}" + (f" ({note})" if note else "")
        reference = clean_text(payload, "reference")

        if source["currency_id"] == destination["currency_id"]:
            if payload.get("to_amount") not in (None, "") and parse_amount(payload, "to_amount") != amount:
                raise ValidationFailed({"to_amount": "Both accounts use the same currency, so the amount received must equal the amount sent."})
            transaction_id = self.ledger.create_transfer(
                context, occurred_at, source["id"], destination["id"], amount, reference, description,
                self._exchange_rate(payload, source["currency_id"]),
            )
        else:
            transaction_id = self._cross_currency_transfer(context, payload, occurred_at, source, destination, amount, reference, description)
        return {"id": str(transaction_id), "ledger_transaction_id": str(transaction_id)}, transaction_id

    def _cross_currency_transfer(self, context, payload, occurred_at, source, destination, amount, reference, description) -> UUID:
        """Money leaves in one currency and arrives in another.

        The two sides must be worth the same in the workspace's base currency. When
        one side *is* the base currency its value is known; when neither is, the
        caller supplies the source currency's rate to base (``exchange_rate``).
        """
        if payload.get("to_amount") in (None, ""):
            raise ValidationFailed(
                {"to_amount": f"{destination['name']} is in a different currency. Enter the amount that arrived."},
                code="TO_AMOUNT_REQUIRED",
            )
        to_amount = parse_amount(payload, "to_amount")
        base = self.lookup.base_currency()
        one = Decimal("1")
        precision = Decimal("0.0000000001")
        if source["currency_id"] == base["id"]:
            base_value, source_rate = amount, one
        elif destination["currency_id"] == base["id"]:
            base_value, source_rate = to_amount, (to_amount / amount).quantize(precision, rounding=ROUND_HALF_UP)
        else:
            if payload.get("exchange_rate") in (None, ""):
                raise ValidationFailed(
                    {"exchange_rate": f"Neither account is in {base['code']}. Enter the rate from the sending account's currency to {base['code']}."},
                    code="EXCHANGE_RATE_REQUIRED",
                )
            source_rate = parse_amount(payload, "exchange_rate")
            base_value = _quantize(amount * source_rate, base["decimal_places"])
        destination_rate = one if destination["currency_id"] == base["id"] else (base_value / to_amount).quantize(precision, rounding=ROUND_HALF_UP)
        if source_rate == one and source["currency_id"] != base["id"] or destination_rate == one and destination["currency_id"] != base["id"]:
            raise ValidationFailed({"to_amount": "These amounts imply an exchange rate of exactly 1 between different currencies. Check the amounts."})
        with self._tx(context):
            transaction_id = self.ledger_repository.create_transaction(occurred_at, reference, description)
            self.ledger_repository.add_entry(transaction_id, destination["id"], to_amount, Decimal("0"), destination_rate)
            self.ledger_repository.add_entry(transaction_id, source["id"], Decimal("0"), amount, source_rate)
            self.ledger_repository.post_transaction(transaction_id)
        return transaction_id

    def reverse(self, context: TenantContextDTO, transaction_id: UUID, payload: dict) -> tuple[dict, UUID]:
        target = self.lookup.reversal_target(transaction_id)
        if target is None:
            raise NotFound("Transaction not found.")
        if target["is_reversal"]:
            raise Conflict(
                "This entry is itself a reversal. To restore the original, record it again as a new transaction.",
                code="REVERSAL_NOT_SUPPORTED",
            )
        if target["is_trade"]:
            # Holdings and average cost are built trade by trade; undoing one in the
            # middle would rewrite every later figure. The correction is another trade.
            raise Conflict(
                "An investment trade cannot be reversed. Record the opposite trade (sell what was bought, or buy back what was sold) instead.",
                code="REVERSAL_NOT_SUPPORTED",
            )
        if target["is_goal_contribution"]:
            raise Conflict("A goal contribution cannot be reversed here.", code="REVERSAL_NOT_SUPPORTED")
        occurred_at, _ = parse_occurrence(payload, timezone=self.timezone)
        reversal_id = self.ledger.reverse_transaction(context, transaction_id, occurred_at, clean_text(payload, "reference"))
        if target["repaid_debt_id"]:
            # The repayment no longer counts (the ledger decides), so a loan it had
            # settled is outstanding again.
            self.lookup.reopen_debt(target["repaid_debt_id"])
        return {"id": str(reversal_id), "reverses_transaction_id": str(transaction_id)}, reversal_id

    # -- recurring ---------------------------------------------------------
    @staticmethod
    def next_occurrence(current: date, frequency: str, anchor_day: int) -> date:
        if frequency == "DAILY":
            return current + timedelta(days=1)
        if frequency == "WEEKLY":
            return current + timedelta(days=7)
        months = 12 if frequency == "YEARLY" else 1
        year = current.year + (current.month - 1 + months) // 12
        month = (current.month - 1 + months) % 12 + 1
        # Keep the original day of the month where the month has it (31st -> 30th/28th, then back to 31st).
        return date(year, month, min(anchor_day, calendar.monthrange(year, month)[1]))

    def run_recurring(self, context: TenantContextDTO, recurring_id: UUID, payload: dict) -> tuple[dict, UUID | None]:
        """Post (or skip) the next due occurrence of a recurring item and move it forward.

        The occurrence row is unique per item and date, so the same occurrence can
        never be posted twice, whoever triggers it.
        """
        definition = self.lookup.recurring_for_update(recurring_id)
        if definition is None:
            raise NotFound("Recurring item not found.")
        if not definition["is_active"]:
            raise Conflict("This recurring item is paused. Resume it first.", code="RECURRING_PAUSED")
        action = str(payload.get("action") or "post").lower()
        if action not in {"post", "skip"}:
            raise ValidationFailed({"action": "action must be post or skip."})
        scheduled_for = definition["next_run_at"]
        today = local_today(self.timezone)
        transaction_id = None
        if action == "post":
            occurred_on = parse_date(payload["occurred_on"], "occurred_on") if payload.get("occurred_on") else min(scheduled_for, today)
            amount = payload.get("amount") if payload.get("amount") not in (None, "") else format(definition["amount"], "f")
            entry = {"amount": amount, "occurred_on": occurred_on.isoformat(), "notes": definition["description"], "reference": clean_text(payload, "reference")}
            kind = definition["transaction_type"]
            if kind == "TRANSFER":
                entry |= {"from_account_id": str(definition["source_account_id"]), "to_account_id": str(definition["destination_account_id"]), "description": definition["description"]}
                if payload.get("to_amount") not in (None, ""):
                    entry["to_amount"] = payload["to_amount"]
                _, transaction_id = self.transfer(context, entry)
            else:
                category_id = payload.get("category_id") or definition["category_id"]
                if not category_id:
                    raise ValidationFailed({"category_id": "Choose a category for this recurring item before posting it."}, code="CATEGORY_REQUIRED")
                entry["category_id"] = str(category_id)
                if kind == "INCOME":
                    entry["destination_account_id"] = str(definition["destination_account_id"])
                    _, transaction_id = self.record_income(context, entry)
                else:
                    entry["source_account_id"] = str(definition["source_account_id"])
                    _, transaction_id = self.record_expense(context, entry)
        self.lookup.record_occurrence(context.tenant_id, recurring_id, scheduled_for, "COMPLETED" if action == "post" else "SKIPPED", transaction_id)
        upcoming = self.next_occurrence(scheduled_for, definition["frequency"], definition["start_date"].day)
        finished = definition["end_date"] is not None and upcoming > definition["end_date"]
        self.lookup.advance_recurring(recurring_id, scheduled_for if finished else upcoming, not finished)
        return {
            "id": str(recurring_id),
            "action": action,
            "scheduled_for": scheduled_for.isoformat(),
            "ledger_transaction_id": str(transaction_id) if transaction_id else None,
            "next_run_at": None if finished else upcoming.isoformat(),
            "is_active": not finished,
        }, transaction_id

    # -- members -----------------------------------------------------------
    def add_member(self, context: TenantContextDTO, payload: dict, hash_password, validate_password) -> dict:
        """Give someone access to this workspace, creating their account if they have none."""
        email = clean_text(payload, "email", 254).lower()
        if "@" not in email or email.startswith("@") or email.endswith("@"):
            raise ValidationFailed({"email": "Enter a valid email address."})
        role = str(payload.get("role") or "MEMBER").upper()
        if role not in {"ADMIN", "MEMBER", "VIEWER"}:
            raise ValidationFailed({"role": "Choose Administrator, Member or Viewer."})
        user = self.lookup.user_by_email(email)
        created_user = False
        if user is None:
            password = payload.get("password")
            if not password:
                raise ValidationFailed(
                    {"password": "No FinTrace account uses this email yet. Set a temporary password to create one."},
                    code="PASSWORD_REQUIRED",
                )
            problems = validate_password(str(password))
            if problems:
                raise ValidationFailed({"password": " ".join(problems)})
            username = email
            if self.lookup.username_taken(username):
                raise Conflict("A user with this username already exists.", code="USER_EXISTS")
            user_id = self.lookup.create_user(username, email, hash_password(str(password)), clean_text(payload, "first_name", 150), clean_text(payload, "last_name", 150))
            created_user = True
        else:
            if user["status"] != "ACTIVE":
                raise Conflict("This user's account is disabled.", code="INACTIVE_USER")
            user_id = user["id"]
        existing = self.lookup.membership_for_user(user_id)
        if existing and existing["status"] == "ACTIVE":
            raise Conflict("This person is already a member of the workspace.", code="ALREADY_MEMBER")
        if existing:
            if existing["status"] == "LEFT":
                raise Conflict("This person left the workspace and cannot be re-added from here.", code="MEMBER_LEFT")
            membership_id = existing["id"]
            self.lookup.set_membership_status(membership_id, "ACTIVE")
        else:
            membership_id = self.lookup.create_membership(context.tenant_id, user_id)
        self.lookup.set_system_role(membership_id, role)
        return {"id": str(membership_id), "user_id": str(user_id), "email": email, "role": role, "created_user": created_user}

    def update_member(self, context: TenantContextDTO, membership_id: UUID, payload: dict) -> dict:
        membership = self.lookup.membership(membership_id)
        if membership is None:
            raise NotFound("Member not found.")
        if membership["user_id"] == context.user_id:
            raise Conflict("You cannot change your own access. Ask another administrator.", code="SELF_CHANGE")
        if membership["is_owner"]:
            raise Conflict("The workspace owner's access cannot be changed.", code="OWNER_PROTECTED")
        unknown = sorted(set(payload) - {"status", "role"})
        if unknown:
            raise ValidationFailed({unknown[0]: "This field cannot be changed."})
        if "status" in payload:
            status = str(payload["status"]).upper()
            if status not in {"ACTIVE", "SUSPENDED"}:
                raise ValidationFailed({"status": "status must be ACTIVE or SUSPENDED."})
            if membership["status"] not in {"ACTIVE", "SUSPENDED"}:
                raise Conflict("This membership cannot be changed.", code="MEMBERSHIP_CLOSED")
            self.lookup.set_membership_status(membership_id, status)
        if "role" in payload:
            role = str(payload["role"]).upper()
            if role not in {"ADMIN", "MEMBER", "VIEWER"} or not self.lookup.set_system_role(membership_id, role):
                raise ValidationFailed({"role": "Choose Administrator, Member or Viewer."})
        return {"id": str(membership_id)}

    # -- accounts ----------------------------------------------------------
    def opening_balance(self, context: TenantContextDTO, account_id: UUID, amount: Decimal, opened_on: date, exchange_rate_payload: dict) -> UUID:
        """Book an account's starting balance against Opening balances equity."""
        account = self.lookup.account(account_id)
        opening_id = self.nominal.get_or_create(context.tenant_id, "OPENING", account["currency_id"])
        rate = self._exchange_rate(exchange_rate_payload, account["currency_id"])
        debit_side = account["normal_balance"] == "DEBIT"
        source, destination = (opening_id, account["id"]) if debit_side else (account["id"], opening_id)
        return self.ledger.create_transfer(
            context, business_datetime(opened_on, self.timezone), source, destination, amount, "OPENING", f"Opening balance: {account['name']}", rate
        )

    # -- debts -------------------------------------------------------------
    def create_debt(self, context: TenantContextDTO, payload: dict) -> tuple[dict, UUID]:
        debt_type = str(payload.get("type") or "PAYABLE").upper()
        if debt_type not in {"PAYABLE", "RECEIVABLE"}:
            raise ValidationFailed({"type": "Choose whether you owe this money or it is owed to you."})
        principal = parse_amount(payload, "principal_amount")
        interest_rate = parse_amount(payload, "interest_rate", required=False, allow_zero=True)
        start_date = parse_date(payload["start_date"], "start_date") if payload.get("start_date") else local_today(self.timezone)
        due_date = parse_date(payload["due_date"], "due_date") if payload.get("due_date") else None
        if due_date and due_date < start_date:
            raise ValidationFailed({"due_date": "The due date cannot be before the start date."})

        contact_id = self._contact_id(payload)
        contact_name = clean_text(payload, "contact_name")
        if contact_id is None:
            if not contact_name:
                raise ValidationFailed({"contact_name": "Enter who the loan is with."})
            contact_id = self.lookup.find_or_create_contact(context.tenant_id, contact_name)
        else:
            contact_name = self.lookup.contact(contact_id)["name"]

        account = self._payment_account(payload, "account_id", "loan") if payload.get("account_id") else None
        if account:
            currency_id = account["currency_id"]
        else:
            currency_id = parse_uuid(payload, "currency_id", required=False) or self.lookup.base_currency()["id"]
            if self.lookup.currency(currency_id) is None:
                raise ValidationFailed({"currency_id": "Choose an active currency."})

        debt_id = self.lookup.create_debt(
            context.tenant_id, debt_type, contact_id, principal, currency_id, interest_rate, start_date, due_date,
            clean_text(payload, "notes", 2000),
        )
        # Book the balance so the ledger knows about the loan from day one.
        counter_id = account["id"] if account else self.nominal.get_or_create(context.tenant_id, "OPENING", currency_id)
        rate = self._exchange_rate(payload, currency_id)
        if debt_type == "PAYABLE":
            loan_account_id = self.nominal.get_or_create(context.tenant_id, "LOANS_PAYABLE", currency_id)
            source, destination, description = loan_account_id, counter_id, f"Loan from {contact_name}"
        else:
            loan_account_id = self.nominal.get_or_create(context.tenant_id, "LOANS_RECEIVABLE", currency_id)
            source, destination, description = counter_id, loan_account_id, f"Loan to {contact_name}"
        transaction_id = self.ledger.create_transfer(
            context, business_datetime(start_date, self.timezone), source, destination, principal, f"DEBT-{str(debt_id)[:8]}", description, rate
        )
        return {"id": str(debt_id), "ledger_transaction_id": str(transaction_id)}, debt_id

    def repay_debt(self, context: TenantContextDTO, debt_id: UUID, payload: dict) -> tuple[dict, UUID]:
        debt = self.lookup.debt_for_update(debt_id)
        if debt is None:
            raise NotFound("Debt not found.")
        if debt["status"] != "ACTIVE":
            raise Conflict("This debt is already settled.", code="DEBT_NOT_ACTIVE")
        if payload.get("principal_amount") in (None, "") and payload.get("interest_amount") in (None, ""):
            principal, interest = parse_amount(payload, "amount"), Decimal("0")
        else:
            principal = parse_amount(payload, "principal_amount", required=False, allow_zero=True)
            interest = parse_amount(payload, "interest_amount", required=False, allow_zero=True)
        if principal + interest <= 0:
            raise ValidationFailed({"principal_amount": "Enter a payment amount."})
        outstanding = debt["outstanding_principal"]
        if principal > outstanding:
            raise ValidationFailed(
                {"principal_amount": f"Only {outstanding.normalize():f} of principal is still outstanding. Put the rest under interest."},
                code="EXCEEDS_OUTSTANDING",
            )
        payable = debt["type"] == "PAYABLE"
        account_field = _first(payload, "account_id", "cash_account_id", "source_account_id")
        account = self._payment_account(payload, account_field, "paid from" if payable else "received into")
        if account["currency_id"] != debt["currency_id"]:
            raise ValidationFailed({account_field: f"{account['name']} is not in the loan's currency."}, code="CURRENCY_MISMATCH")
        currency_id = debt["currency_id"]
        loan_account_id = parse_uuid(payload, "liability_account_id", required=False) or self.nominal.get_or_create(
            context.tenant_id, "LOANS_PAYABLE" if payable else "LOANS_RECEIVABLE", currency_id
        )
        interest_account_id = None
        if interest > 0:
            interest_account_id = parse_uuid(payload, "interest_expense_account_id", required=False) or self.nominal.get_or_create(
                context.tenant_id, "EXPENSE" if payable else "INCOME", currency_id
            )
        occurred_at, repaid_on = parse_occurrence(payload, "repaid_on", self.timezone)
        who = debt["contact_name"] or "lender"
        dto = CreateDebtRepaymentDTO(
            debt_id=debt_id, occurred_at=occurred_at, repaid_on=repaid_on,
            liability_account_id=loan_account_id, interest_expense_account_id=interest_account_id,
            cash_account_id=account["id"], principal_amount=principal, interest_amount=interest,
            reference=clean_text(payload, "reference"),
            notes=clean_text(payload, "notes", 2000) or (f"Loan repayment to {who}" if payable else f"Loan repayment from {who}"),
            debt_type=debt["type"], exchange_rate=self._exchange_rate(payload, currency_id),
            settles_debt=principal == outstanding,
        )
        transaction_id, repayment_id = DebtService(self.ledger_repository, self.metadata_repository).create_repayment(context, dto)
        return {
            "id": str(repayment_id),
            "ledger_transaction_id": str(transaction_id),
            "outstanding_principal": format((outstanding - principal).normalize(), "f"),
            "status": "PAID" if dto.settles_debt else "ACTIVE",
        }, transaction_id

    # -- investments -------------------------------------------------------
    def _instrument(self, context: TenantContextDTO, payload: dict, currency_id: UUID, *, create: bool) -> dict:
        instrument_id = parse_uuid(payload, "instrument_id", required=False)
        if instrument_id:
            instrument = self.lookup.instrument(instrument_id)
            if instrument is None:
                raise ValidationFailed({"instrument_id": "The investment was not found in this workspace."})
            if instrument["currency_id"] != currency_id:
                raise ValidationFailed({"instrument_id": f"{instrument['symbol']} trades in a different currency than the selected account."}, code="CURRENCY_MISMATCH")
            return instrument
        symbol = clean_text(payload, "symbol", 50).upper()
        if not symbol:
            raise ValidationFailed({"symbol": "Enter the investment's symbol or name."})
        instrument = self.lookup.find_instrument(symbol, currency_id)
        if instrument:
            return instrument
        if not create:
            raise ValidationFailed({"symbol": f"You do not hold {symbol}."})
        instrument_type = str(payload.get("instrument_type") or "STOCK").upper()
        if instrument_type not in INSTRUMENT_TYPES:
            raise ValidationFailed({"instrument_type": "Choose a valid investment type."})
        new_id = self.lookup.create_instrument(context.tenant_id, symbol, clean_text(payload, "name") or symbol, instrument_type, currency_id)
        return {"id": new_id, "symbol": symbol, "currency_id": currency_id}

    def _portfolio_id(self, context: TenantContextDTO, payload: dict, currency_id: UUID) -> UUID:
        portfolio_id = parse_uuid(payload, "portfolio_id", required=False)
        if portfolio_id:
            if self.lookup.portfolio(portfolio_id) is None:
                raise ValidationFailed({"portfolio_id": "The portfolio was not found in this workspace."})
            return portfolio_id
        return self.lookup.default_portfolio(context.tenant_id, currency_id)

    def record_trade(self, context: TenantContextDTO, payload: dict) -> tuple[dict, UUID]:
        trade_type = str(payload.get("trade_type") or "").upper()
        if trade_type not in {"BUY", "SELL"}:
            raise ValidationFailed({"trade_type": "Choose Buy or Sell."})
        quantity = parse_amount(payload, "quantity")
        price = parse_amount(payload, "price")
        fees = parse_amount(payload, "fees", required=False, allow_zero=True)
        account_field = _first(payload, "settlement_account_id", "cash_account_id")
        account = self._payment_account(payload, account_field, "settlement")
        currency_id = account["currency_id"]
        instrument = self._instrument(context, payload, currency_id, create=trade_type == "BUY")
        portfolio_id = self._portfolio_id(context, payload, currency_id)
        investment_account_id = parse_uuid(payload, "investment_account_id", required=False) or self.nominal.get_or_create(
            context.tenant_id, "INVESTMENTS", currency_id
        )
        decimals = account["decimal_places"]
        gross = _quantize(quantity * price, decimals)
        pnl_account_id = parse_uuid(payload, "realized_pnl_account_id", required=False)
        if trade_type == "SELL":
            position = self.lookup.position(portfolio_id, instrument["id"])
            held = position["quantity"] if position else Decimal("0")
            if held < quantity:
                raise ValidationFailed({"quantity": f"You hold {held.normalize():f} {instrument['symbol']}; you cannot sell {quantity.normalize():f}."}, code="INSUFFICIENT_HOLDING")
            if gross - fees < 0:
                raise ValidationFailed({"fees": "Fees cannot exceed the sale proceeds."})
            if pnl_account_id is None:
                gain = (price - position["average_cost"]) * quantity - fees
                pnl_account_id = self.nominal.get_or_create(context.tenant_id, "INCOME" if gain >= 0 else "EXPENSE", currency_id)
        occurred_at, _ = parse_occurrence(payload, "traded_on", self.timezone)
        trade_payload = {
            "trade_type": trade_type, "quantity": quantity, "price": price, "fees": fees,
            "portfolio_id": str(portfolio_id), "instrument_id": str(instrument["id"]),
            "cash_account_id": str(account["id"]), "investment_account_id": str(investment_account_id),
            "realized_pnl_account_id": str(pnl_account_id) if pnl_account_id else None,
            "occurred_at": occurred_at, "traded_at": occurred_at,
            "reference": clean_text(payload, "reference"),
            "notes": clean_text(payload, "notes", 2000) or f"{'Bought' if trade_type == 'BUY' else 'Sold'} {quantity.normalize():f} {instrument['symbol']}",
            "exchange_rate": self._exchange_rate(payload, currency_id), "decimals": decimals,
        }
        trade_id, transaction_id = InvestmentService(self.ledger_repository, InvestmentRepository()).create_trade(context, trade_payload)
        return {"id": str(trade_id), "ledger_transaction_id": str(transaction_id), "instrument_id": str(instrument["id"])}, trade_id

    def record_dividend(self, context: TenantContextDTO, payload: dict) -> tuple[dict, UUID]:
        amount = parse_amount(payload)
        account_field = _first(payload, "deposit_account_id", "cash_account_id")
        account = self._payment_account(payload, account_field, "received into")
        currency_id = account["currency_id"]
        instrument = self._instrument(context, payload, currency_id, create=False)
        portfolio_id = self._portfolio_id(context, payload, currency_id)
        income_account_id = parse_uuid(payload, "income_account_id", required=False) or self.nominal.get_or_create(
            context.tenant_id, "INCOME", currency_id
        )
        occurred_at, paid_on = parse_occurrence(payload, "paid_on", self.timezone)
        dividend_payload = {
            "amount": amount, "currency_id": str(currency_id), "paid_on": paid_on,
            "portfolio_id": str(portfolio_id), "instrument_id": str(instrument["id"]),
            "cash_account_id": str(account["id"]), "income_account_id": str(income_account_id),
            "occurred_at": occurred_at, "reference": clean_text(payload, "reference"),
            "notes": clean_text(payload, "notes", 2000) or f"Dividend from {instrument['symbol']}",
            "exchange_rate": self._exchange_rate(payload, currency_id),
        }
        dividend_id, transaction_id = InvestmentService(self.ledger_repository, InvestmentRepository()).create_dividend(context, dividend_payload)
        return {"id": str(dividend_id), "ledger_transaction_id": str(transaction_id)}, dividend_id
