import json
from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid4

from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.http import JsonResponse
from django.views import View

from FinTrace.apps.core.application.dto import CreateLedgerTransactionDTO, LedgerEntryDTO, TenantContextDTO
from FinTrace.apps.core.application.flows import FinancialFlows
from FinTrace.apps.core.application.parsing import json_body, local_today, optional_date, parse_amount, parse_date, parse_period
from FinTrace.apps.core.application.services import CurrencyService, IdempotencyService, LedgerService, ReportingService, ResourceService, TenantAwareService, TenantService
from FinTrace.apps.core.domain.exceptions import ApiError, AuthenticationRequired, Conflict, NoActiveTenant, NotFound, PermissionDenied, ValidationFailed
from FinTrace.apps.core.infrastructure.database.utils import serialize_row, serialize_rows
from FinTrace.apps.core.infrastructure.read_models import NORMAL_BALANCE_BY_TYPE, FinancialReadRepository
from FinTrace.apps.core.infrastructure.repositories import DjangoCurrencyRepository, IdempotencyRepository, PostgreSQLLedgerRepository, ReportingRepository, TenantResourceRepository
from FinTrace.apps.core.presentation.exception_handlers import error_response, safe_view


def _json_body(request) -> dict:
    return json_body(request)


def _pagination(request) -> tuple[int, int]:
    default = settings.FINTRACE_DEFAULT_PAGE_SIZE
    max_size = settings.FINTRACE_MAX_PAGE_SIZE
    try:
        limit = min(max(int(request.GET.get("limit", default)), 1), max_size)
        offset = max(int(request.GET.get("offset", 0)), 0)
    except ValueError:
        raise ValidationFailed({"limit": "limit and offset must be whole numbers."}) from None
    return limit, offset


def _client_ip(request) -> str | None:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.META.get("REMOTE_ADDR")


def tenant_context(request) -> TenantContextDTO:
    if not getattr(request.user, "is_authenticated", False):
        raise AuthenticationRequired("Sign in to continue.")

    tenant_id = request.session.get("active_company_id")
    if not tenant_id:
        raise NoActiveTenant("No active workspace. Choose a workspace first.")

    user_id = getattr(request.user, "id", None)
    if not user_id:
        raise AuthenticationRequired("Sign in to continue.")

    request_id = getattr(request, "request_id", None) or request.headers.get("X-Request-ID")
    try:
        request_uuid = UUID(str(request_id)) if request_id else uuid4()
    except ValueError:
        request_uuid = uuid4()
    return TenantContextDTO(
        user_id=UUID(str(user_id)),
        tenant_id=UUID(str(tenant_id)),
        request_id=request_uuid,
        client_ip=_client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", ""),
    )


def _idempotent_json(request, context: TenantContextDTO, scope: str, payload: dict, operation, *, required: bool = True):
    """Run ``operation`` at most once per (tenant, scope, Idempotency-Key).

    The key claim, the operation and the stored response share one database
    transaction: either all of it commits or none of it does. ``operation``
    returns (response payload, HTTP status, business id).
    """
    key = (request.headers.get("Idempotency-Key") or "").strip()
    service = IdempotencyService(IdempotencyRepository())
    if not key:
        if required:
            return error_response(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required.")
        with service._tx(context):
            response_payload, status, _ = operation()
        return JsonResponse(response_payload, status=status)
    if len(key) > 255:
        return error_response(400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be at most 255 characters.")
    with service._tx(context):
        started = service.begin(context, scope, key, payload)
        op = started["operation"]
        if started["reuse"]:
            response_payload = op.get("response_payload") or {}
            if isinstance(response_payload, str):
                response_payload = json.loads(response_payload)
            response = JsonResponse(response_payload, status=op.get("response_status") or 200)
            response["Idempotent-Replayed"] = "true"
            return response
        response_payload, status, business_id = operation()
        service.complete(context, op["id"], business_id, status, response_payload)
    return JsonResponse(response_payload, status=status)


def _password_problems(password: str) -> list[str]:
    try:
        validate_password(password)
    except ValidationError as exc:
        return list(exc.messages)
    return []


def _list_response(rows, limit: int, offset: int, total: int | None = None) -> JsonResponse:
    body = {"results": serialize_rows(rows), "limit": limit, "offset": offset}
    if total is not None:
        body["total"] = total
    return JsonResponse(body)


def _read(context: TenantContextDTO, fn):
    """Run a read-model query inside the tenant's database context."""
    with TenantAwareService()._tx(context):
        return fn(FinancialReadRepository())


class SafeView(View):
    @classmethod
    def as_view(cls, **initkwargs):
        return safe_view(super().as_view(**initkwargs))

    def http_method_not_allowed(self, request, *args, **kwargs):
        return error_response(405, "METHOD_NOT_ALLOWED", f"{request.method} is not supported here.")


class CurrencyListView(SafeView):
    def get(self, request):
        if not getattr(request.user, "is_authenticated", False):
            raise AuthenticationRequired("Sign in to continue.")
        currencies = CurrencyService(DjangoCurrencyRepository()).list_active_currencies()
        return JsonResponse({"results": [{**currency.__dict__, "id": str(currency.id)} for currency in currencies]})


def _prepare_account_payload(payload: dict) -> tuple[dict, Decimal | None, str | None]:
    """Derive accounting attributes so callers never have to send them."""
    payload = dict(payload)
    opening_raw = payload.pop("opening_balance", None)
    opening_date = payload.pop("opening_date", None)
    account_type = str(payload.get("type") or "").strip().upper()
    if account_type not in NORMAL_BALANCE_BY_TYPE:
        raise ValidationFailed({"type": "Choose a valid account type."})
    if account_type in {"INCOME", "EXPENSE", "EQUITY"}:
        raise ValidationFailed({"type": "Income, expense and equity accounts are managed by FinTrace and cannot be created here."})
    expected = NORMAL_BALANCE_BY_TYPE[account_type]
    supplied = str(payload.get("normal_balance") or expected).strip().upper()
    if account_type != "OTHER" and supplied != expected:
        raise ValidationFailed({"normal_balance": f"A {account_type} account must have a {expected} normal balance."})
    if supplied not in {"DEBIT", "CREDIT"}:
        raise ValidationFailed({"normal_balance": "normal_balance must be DEBIT or CREDIT."})
    payload["type"] = account_type
    payload["normal_balance"] = supplied
    if not str(payload.get("name") or "").strip():
        raise ValidationFailed({"name": "Enter an account name."})
    if not payload.get("currency_id"):
        raise ValidationFailed({"currency_id": "Choose a currency."})
    opening = None
    if opening_raw not in (None, "", 0, "0"):
        opening = parse_amount({"opening_balance": opening_raw}, "opening_balance")
    return payload, opening, opening_date


def _prepare_recurring_payload(payload: dict, context: TenantContextDTO) -> dict:
    """Fill in what can be derived so a schedule needs only what a person would say."""
    payload = dict(payload)
    kind = str(payload.get("transaction_type") or "").upper()
    if kind not in {"INCOME", "EXPENSE", "TRANSFER"}:
        raise ValidationFailed({"transaction_type": "Choose income, expense or transfer."})
    payload["transaction_type"] = kind
    parse_amount(payload)
    if not payload.get("next_run_at"):
        raise ValidationFailed({"next_run_at": "Choose the next date this should happen."})
    payload.setdefault("start_date", payload["next_run_at"])
    account_field = "destination_account_id" if kind == "INCOME" else "source_account_id"
    if not payload.get(account_field):
        raise ValidationFailed({account_field: "Choose an account."})
    if kind == "TRANSFER":
        if not payload.get("destination_account_id"):
            raise ValidationFailed({"destination_account_id": "Choose the account to transfer to."})
        if payload["destination_account_id"] == payload["source_account_id"]:
            raise ValidationFailed({"destination_account_id": "Choose two different accounts."})
        payload["category_id"] = None
    else:
        payload["source_account_id" if kind == "INCOME" else "destination_account_id"] = None
    if not payload.get("currency_id"):
        account_id = payload[account_field]

        def currency(repo: FinancialReadRepository):
            rows = repo.list_accounts(1, 0, UUID(str(account_id)))
            return rows[0]["currency_id"] if rows else None
        currency_id = _read(context, currency)
        if currency_id is None:
            raise ValidationFailed({account_field: "The account was not found in this workspace."})
        payload["currency_id"] = str(currency_id)
    return payload


class ResourceCollectionView(SafeView):
    resource = ""

    def _service(self):
        repository = TenantResourceRepository(self.resource)
        if self.resource == "tenants":
            return TenantService(repository)
        return ResourceService(repository)

    def get(self, request):
        limit, offset = _pagination(request)
        context = tenant_context(request)
        if self.resource == "accounts":
            return _list_response(_read(context, lambda repo: repo.list_accounts(limit, offset)), limit, offset)
        if self.resource == "debts":
            return _list_response(_read(context, lambda repo: repo.list_debts(limit, offset)), limit, offset)
        if self.resource == "memberships":
            return _list_response(_read(context, lambda repo: repo.list_members(limit, offset)), limit, offset)
        if self.resource == "recurring-transactions":
            return _list_response(_read(context, lambda repo: repo.list_recurring(limit, offset)), limit, offset)
        rows = self._service().list(context, limit, offset)
        return _list_response(rows, limit, offset)

    def post(self, request):
        context = tenant_context(request)
        payload = _json_body(request)
        service = self._service()

        if self.resource == "debts":
            flows = FinancialFlows()

            def create_debt():
                body, debt_id = flows.create_debt(context, payload)
                return body, 201, debt_id
            return _idempotent_json(request, context, "debts.create", payload, create_debt)

        if self.resource == "tenants":
            return JsonResponse({"id": str(service.create(context, payload))}, status=201)

        if self.resource == "memberships":
            def add_member():
                return FinancialFlows().add_member(context, payload, make_password, _password_problems), 201, None
            return _idempotent_json(request, context, "memberships.create", payload, add_member, required=False)

        opening = opening_date = None
        if self.resource == "accounts":
            payload_to_store, opening, opening_date = _prepare_account_payload(payload)
        elif self.resource == "recurring-transactions":
            payload_to_store = _prepare_recurring_payload(payload, context)
        else:
            payload_to_store = payload

        def create():
            row_id = service.create(context, payload_to_store)
            if opening is not None:
                flows = FinancialFlows()
                opened_on = parse_date(opening_date, "opening_date") if opening_date else local_today(flows.timezone)
                flows.opening_balance(context, row_id, opening, opened_on, payload)
            if self.resource == "accounts":
                row = FinancialReadRepository().list_accounts(1, 0, row_id)
                body = serialize_row(row[0]) if row else {"id": str(row_id)}
            else:
                row = service.get(context, row_id)
                body = serialize_row(row) if row else {"id": str(row_id)}
            return body, 201, None

        return _idempotent_json(request, context, f"{self.resource}.create", payload, create, required=False)


class ResourceDetailView(SafeView):
    resource = ""

    def _service(self):
        return ResourceService(TenantResourceRepository(self.resource))

    def _existing(self, context, row_id) -> dict:
        row = self._service().get(context, row_id)
        if row is None:
            raise NotFound("Resource not found.")
        return row

    def get(self, request, row_id):
        context = tenant_context(request)
        if self.resource == "accounts":
            rows = _read(context, lambda repo: repo.list_accounts(1, 0, row_id))
        elif self.resource == "debts":
            rows = _read(context, lambda repo: repo.list_debts(1, 0, row_id))
        else:
            rows = [self._existing(context, row_id)]
        if not rows:
            raise NotFound("Resource not found.")
        return JsonResponse(serialize_row(rows[0]))

    def patch(self, request, row_id):
        context = tenant_context(request)
        if self.resource == "memberships":
            payload = _json_body(request)
            with TenantAwareService()._tx(context):
                body = FinancialFlows().update_member(context, row_id, payload)
            return JsonResponse(body)
        existing = self._existing(context, row_id)
        if existing.get("is_system"):
            raise Conflict("This account is managed by FinTrace and cannot be changed.", code="SYSTEM_RECORD")
        self._service().update(context, row_id, _json_body(request))
        return self.get(request, row_id)


class ResourceArchiveView(SafeView):
    resource = ""

    def post(self, request, row_id):
        context = tenant_context(request)
        service = ResourceService(TenantResourceRepository(self.resource))
        existing = service.get(context, row_id)
        if existing is None:
            raise NotFound("Resource not found.")
        if existing.get("is_system"):
            raise Conflict("This account is managed by FinTrace and cannot be archived.", code="SYSTEM_RECORD")
        service.archive(context, row_id)
        return JsonResponse({"status": "archived", "id": str(row_id)})


def _transaction_filters(request, forced_type: str | None = None) -> dict:
    params = request.GET
    return {
        "type": forced_type or params.get("type"),
        "status": params.get("status"),
        "account_id": params.get("account_id"),
        "category_id": params.get("category_id"),
        "date_from": optional_date(params, "date_from"),
        "date_to": optional_date(params, "date_to"),
        "q": (params.get("q") or "").strip()[:100],
    }


class LedgerTransactionView(SafeView):
    def get(self, request):
        limit, offset = _pagination(request)
        context = tenant_context(request)
        filters = _transaction_filters(request)
        rows, total = _read(context, lambda repo: repo.list_transactions(filters, limit, offset))
        return _list_response(rows, limit, offset, total)

    def post(self, request):
        payload = _json_body(request)
        entries = tuple(
            LedgerEntryDTO(
                account_id=UUID(item["account_id"]),
                debit_amount=Decimal(str(item.get("debit_amount", "0"))),
                credit_amount=Decimal(str(item.get("credit_amount", "0"))),
                exchange_rate=Decimal(str(item.get("exchange_rate", "1"))),
            )
            for item in payload.get("entries", [])
        )
        dto = CreateLedgerTransactionDTO(
            occurred_at=datetime.fromisoformat(payload["occurred_at"]),
            reference=payload.get("reference", ""),
            description=payload.get("description", ""),
            entries=entries,
        )
        transaction_id = LedgerService(PostgreSQLLedgerRepository()).create_transaction(tenant_context(request), dto)
        return JsonResponse({"id": str(transaction_id)}, status=201)


class LedgerTransactionDetailView(SafeView):
    def get(self, request, transaction_id):
        row = _read(tenant_context(request), lambda repo: repo.get_transaction(transaction_id))
        if row is None:
            raise NotFound("Transaction not found.")
        return JsonResponse(serialize_row(row))


class LedgerEntryCreateView(SafeView):
    def post(self, request, transaction_id):
        payload = _json_body(request)
        entry_id = LedgerService(PostgreSQLLedgerRepository()).add_entry(
            tenant_context(request),
            transaction_id,
            UUID(payload["account_id"]),
            Decimal(str(payload.get("debit_amount", "0"))),
            Decimal(str(payload.get("credit_amount", "0"))),
            Decimal(str(payload.get("exchange_rate", "1"))),
        )
        return JsonResponse({"id": str(entry_id)}, status=201)


class LedgerEntryDeleteView(SafeView):
    def delete(self, request, transaction_id, entry_id):
        LedgerService(PostgreSQLLedgerRepository()).delete_entry(tenant_context(request), entry_id)
        return JsonResponse({"status": "deleted"})


class LedgerPostView(SafeView):
    def post(self, request, transaction_id):
        LedgerService(PostgreSQLLedgerRepository()).post_transaction(tenant_context(request), transaction_id)
        return JsonResponse({"status": "posted"})


class LedgerCancelView(SafeView):
    def post(self, request, transaction_id):
        LedgerService(PostgreSQLLedgerRepository()).cancel_transaction(tenant_context(request), transaction_id)
        return JsonResponse({"status": "cancelled"})


class LedgerReverseView(SafeView):
    def post(self, request, transaction_id):
        payload = _json_body(request)
        context = tenant_context(request)
        flows = FinancialFlows()

        def operation():
            body, reversal_id = flows.reverse(context, transaction_id, payload)
            return body, 201, reversal_id
        return _idempotent_json(request, context, "ledger.reverse", payload | {"transaction_id": str(transaction_id)}, operation)


def _record_filters(request) -> dict:
    return {
        "date_from": optional_date(request.GET, "date_from"),
        "date_to": optional_date(request.GET, "date_to"),
        "category_id": request.GET.get("category_id"),
    }


class IncomeCreateView(SafeView):
    kind = "INCOME"
    scope = "income.create"

    def get(self, request):
        limit, offset = _pagination(request)
        filters = _record_filters(request)
        rows, total = _read(tenant_context(request), lambda repo: repo.list_records(self.kind, filters, limit, offset))
        return _list_response(rows, limit, offset, total)

    def _record(self, flows, context, payload):
        return flows.record_income(context, payload)

    def post(self, request):
        payload = _json_body(request)
        context = tenant_context(request)
        flows = FinancialFlows()

        def operation():
            body, transaction_id = self._record(flows, context, payload)
            return body, 201, transaction_id
        return _idempotent_json(request, context, self.scope, payload, operation)


class IncomeDetailView(SafeView):
    kind = "INCOME"
    label = "Income"

    def get(self, request, row_id):
        rows, _ = _read(tenant_context(request), lambda repo: repo.list_records(self.kind, {"id": row_id}, 1, 0))
        if not rows:
            raise NotFound(f"{self.label} record not found.")
        return JsonResponse(serialize_row(rows[0]))


class ExpenseCreateView(IncomeCreateView):
    kind = "EXPENSE"
    scope = "expenses.create"

    def _record(self, flows, context, payload):
        return flows.record_expense(context, payload)


class ExpenseDetailView(IncomeDetailView):
    kind = "EXPENSE"
    label = "Expense"


class TransferView(SafeView):
    def get(self, request):
        limit, offset = _pagination(request)
        filters = _transaction_filters(request, "TRANSFER")
        rows, total = _read(tenant_context(request), lambda repo: repo.list_transactions(filters, limit, offset))
        return _list_response(rows, limit, offset, total)

    def post(self, request):
        payload = _json_body(request)
        context = tenant_context(request)
        flows = FinancialFlows()

        def operation():
            body, transaction_id = flows.transfer(context, payload)
            return body, 201, transaction_id
        return _idempotent_json(request, context, "transfers.create", payload, operation)


class DebtRepaymentView(SafeView):
    def get(self, request, row_id):
        limit, offset = _pagination(request)
        rows = _read(tenant_context(request), lambda repo: repo.list_debt_repayments(row_id, limit, offset))
        return _list_response(rows, limit, offset)

    def post(self, request, row_id):
        payload = _json_body(request)
        context = tenant_context(request)
        flows = FinancialFlows()

        def operation():
            body, transaction_id = flows.repay_debt(context, row_id, payload)
            return body, 201, transaction_id
        return _idempotent_json(request, context, "debts.repayment", payload | {"debt_id": str(row_id)}, operation)


def _money(value) -> str:
    return format(value, "f")


def _breakdown(repo: FinancialReadRepository, kind: str, date_from, date_to) -> dict:
    data = repo.category_breakdown(kind, date_from, date_to)
    return {
        "total": _money(data["total"]),
        "results": [
            {
                "category_id": str(row["category_id"]) if row["category_id"] else None,
                "category": row["category"],
                "amount": _money(row["amount"]),
                "percentage": row["percentage"],
                "count": row["count"],
            }
            for row in data["results"]
        ],
    }


def _cashflow(repo: FinancialReadRepository, months: int, until) -> list[dict]:
    return [
        {
            "month": row["month"],
            "month_start": row["month_start"].isoformat(),
            "income": _money(row["income"]),
            "expenses": _money(row["expenses"]),
            "net": _money(row["net"]),
        }
        for row in repo.monthly_cashflow(months, until)
    ]


def _require(repo: FinancialReadRepository, *codes: str) -> None:
    granted = repo.has_permissions(list(codes))
    missing = [code for code in codes if not granted[code]]
    if missing:
        raise PermissionDenied(f"You need the {', '.join(missing)} permission to see this.")


def _months(request) -> int:
    try:
        return min(max(int(request.GET.get("months", 6)), 1), 36)
    except ValueError:
        raise ValidationFailed({"months": "months must be a whole number."}) from None


class ReportView(SafeView):
    """Ledger-derived reports. Each one states the period it covers."""

    def get(self, request, report_name):
        context = tenant_context(request)
        if report_name in {"spending-by-category", "income-by-category"}:
            kind = "EXPENSE" if report_name == "spending-by-category" else "INCOME"

            def breakdown(repo):
                _require(repo, "transactions.view", "accounts.view")
                date_from, date_to = parse_period(request.GET, repo.timezone)
                return {**_breakdown(repo, kind, date_from, date_to), "date_from": date_from.isoformat(), "date_to": date_to.isoformat()}
            return JsonResponse(_read(context, breakdown))
        if report_name == "cashflow":
            months = _months(request)

            def cashflow(repo):
                _require(repo, "transactions.view", "accounts.view")
                return _cashflow(repo, months, optional_date(request.GET, "date_to") or local_today(repo.timezone))
            return JsonResponse({"results": _read(context, cashflow), "months": months})
        if report_name == "investment-position-summary":
            limit, offset = _pagination(request)
            return _list_response(_read(context, lambda repo: repo.list_holdings(limit, offset)), limit, offset)
        limit, offset = _pagination(request)
        rows = ReportingService(ReportingRepository()).list_report(context, report_name, limit, offset)
        return _list_response(rows, limit, offset)


class RecurringRunView(SafeView):
    """Post or skip the next due occurrence of a recurring item."""

    def post(self, request, row_id):
        payload = _json_body(request)
        context = tenant_context(request)
        flows = FinancialFlows()

        def operation():
            body, _ = flows.run_recurring(context, row_id, payload)
            return body, 201, None
        return _idempotent_json(request, context, "recurring.run", payload | {"recurring_id": str(row_id)}, operation)


class ActivityView(SafeView):
    """A readable feed of who changed what in this workspace."""

    def get(self, request):
        limit, offset = _pagination(request)
        return _list_response(_read(tenant_context(request), lambda repo: repo.list_activity(limit, offset)), limit, offset)


class DashboardSummaryView(SafeView):
    """Everything the dashboard shows, in one request and one consistent snapshot."""

    def get(self, request):
        context = tenant_context(request)
        months = _months(request)

        def build(repo: FinancialReadRepository) -> dict:
            _require(repo, "dashboard.view", "accounts.view", "transactions.view")
            date_from, date_to = parse_period(request.GET, repo.timezone)
            tenant = repo.tenant_profile()
            sheet = repo.balance_sheet()
            totals = repo.period_totals(date_from, date_to)
            recent, _ = repo.list_transactions({}, 8, 0)
            debts = repo.debt_exposure()
            investments = repo.investment_exposure()
            return {
                "period": {"date_from": date_from.isoformat(), "date_to": date_to.isoformat(), "timezone": tenant["timezone"]},
                "currency": {
                    "id": str(tenant["base_currency_id"]),
                    "code": tenant["base_currency_code"],
                    "symbol": tenant["base_currency_symbol"],
                    "decimal_places": tenant["base_currency_decimals"],
                },
                "totals": {
                    "assets": _money(sheet["assets"]),
                    "liabilities": _money(sheet["liabilities"]),
                    "net_worth": _money(sheet["net_worth"]),
                    "income": _money(totals["income"]),
                    "expenses": _money(totals["expenses"]),
                    "net_cash_flow": _money(totals["net_cash_flow"]),
                    "savings_rate": float(totals["savings_rate"]) if totals["savings_rate"] is not None else None,
                },
                "accounts": serialize_rows(sheet["accounts"]),
                "spending_by_category": _breakdown(repo, "EXPENSE", date_from, date_to),
                "income_by_category": _breakdown(repo, "INCOME", date_from, date_to),
                "cashflow": _cashflow(repo, months, date_to),
                "recent_transactions": serialize_rows(recent),
                "debts": {
                    "payable": _money(debts["payable"]),
                    "receivable": _money(debts["receivable"]),
                    "active_count": debts["active_count"],
                },
                "investments": {
                    "cost_basis": _money(investments["cost_basis"]),
                    "holding_count": investments["holding_count"],
                },
            }
        body = _read(context, build)
        body["broker"] = _broker_headline(context)
        return JsonResponse(body)


def _broker_headline(context: TenantContextDTO) -> dict | None:
    """The connected broker portfolio at a glance. Reference only: it is not part of net worth."""
    from FinTrace.apps.core.application.broker import BrokerService

    try:
        portfolio = BrokerService().portfolio(context)
    except ApiError:
        return None  # no permission to see investments
    connection, summary = portfolio.get("connection"), portfolio.get("summary")
    if not connection or connection["status"] == "DISCONNECTED" or not summary or not summary["holding_count"]:
        return None
    return serialize_row({
        "provider": portfolio["provider"], "status": connection["status"], "currency": portfolio["currency"],
        "last_synced_at": connection["last_synced_at"], "holding_count": summary["holding_count"],
        "invested_value": summary["invested_value"], "current_value": summary["current_value"], "pnl": summary["pnl"],
        "pnl_percent": summary["pnl_percent"], "day_change": summary["day_change"], "day_change_percent": summary["day_change_percent"],
    })


from FinTrace.apps.core.application.services import AuditService, AssetService, GoalService, RBACService, RecurringService, TagService
from FinTrace.apps.core.infrastructure.repositories import AuditRepository, HistoryRepository, RBACRepository, RecurringRepository, TagAssociationRepository


class RBACListView(SafeView):
    collection = "roles"

    def get(self, request):
        limit, offset = _pagination(request)
        service = RBACService(RBACRepository())
        method = {
            "pages": service.list_pages,
            "actions": service.list_actions,
            "permissions": service.list_permissions,
            "roles": service.list_roles,
        }[self.collection]
        return JsonResponse({"results": serialize_rows(method(tenant_context(request), limit, offset)), "limit": limit, "offset": offset})

    def post(self, request):
        if self.collection != "roles":
            return error_response(405, "METHOD_NOT_ALLOWED", "This RBAC collection is read-only.")
        role_id = RBACService(RBACRepository()).create_role(tenant_context(request), _json_body(request))
        return JsonResponse({"id": str(role_id)}, status=201)


class RBACRolePermissionView(SafeView):
    def post(self, request, role_id):
        RBACService(RBACRepository()).assign_permission(tenant_context(request), role_id, _json_body(request))
        return JsonResponse({"status": "assigned"})

    def delete(self, request, role_id, permission_id):
        RBACService(RBACRepository()).remove_permission(tenant_context(request), role_id, permission_id)
        return JsonResponse({"status": "removed"})


class RBACMembershipRoleView(SafeView):
    def post(self, request, membership_id):
        RBACService(RBACRepository()).assign_role(tenant_context(request), membership_id, _json_body(request))
        return JsonResponse({"status": "assigned"})

    def delete(self, request, membership_id, role_id):
        RBACService(RBACRepository()).remove_role(tenant_context(request), membership_id, role_id)
        return JsonResponse({"status": "removed"})


class RBACOverrideView(SafeView):
    def post(self, request, membership_id):
        override_id = RBACService(RBACRepository()).create_override(tenant_context(request), membership_id, _json_body(request))
        return JsonResponse({"id": str(override_id)}, status=201)

    def delete(self, request, override_id):
        RBACService(RBACRepository()).remove_override(tenant_context(request), override_id)
        return JsonResponse({"status": "removed"})


class EffectivePermissionsView(SafeView):
    def get(self, request):
        rows = RBACService(RBACRepository()).effective_permissions(tenant_context(request))
        return JsonResponse({"results": serialize_rows(rows)})


class IncomeTagsView(SafeView):
    def get(self, request, row_id):
        return JsonResponse({"results": serialize_rows(TagService(TagAssociationRepository()).list_income_tags(tenant_context(request), row_id))})

    def post(self, request, row_id):
        TagService(TagAssociationRepository()).add_income_tag(tenant_context(request), row_id, UUID(_json_body(request)["tag_id"]))
        return JsonResponse({"status": "tagged"}, status=201)


class ExpenseTagsView(SafeView):
    def get(self, request, row_id):
        return JsonResponse({"results": serialize_rows(TagService(TagAssociationRepository()).list_expense_tags(tenant_context(request), row_id))})

    def post(self, request, row_id):
        TagService(TagAssociationRepository()).add_expense_tag(tenant_context(request), row_id, UUID(_json_body(request)["tag_id"]))
        return JsonResponse({"status": "tagged"}, status=201)


class IncomeTagDetailView(SafeView):
    def post(self, request, row_id, tag_id):
        TagService(TagAssociationRepository()).add_income_tag(tenant_context(request), row_id, tag_id)
        return JsonResponse({"status": "tagged"}, status=201)

    def delete(self, request, row_id, tag_id):
        TagService(TagAssociationRepository()).remove_income_tag(tenant_context(request), row_id, tag_id)
        return JsonResponse({"status": "untagged"})


class ExpenseTagDetailView(SafeView):
    def post(self, request, row_id, tag_id):
        TagService(TagAssociationRepository()).add_expense_tag(tenant_context(request), row_id, tag_id)
        return JsonResponse({"status": "tagged"}, status=201)

    def delete(self, request, row_id, tag_id):
        TagService(TagAssociationRepository()).remove_expense_tag(tenant_context(request), row_id, tag_id)
        return JsonResponse({"status": "untagged"})


class InvestmentTradeView(SafeView):
    def get(self, request):
        limit, offset = _pagination(request)
        return _list_response(_read(tenant_context(request), lambda repo: repo.list_trades(limit, offset)), limit, offset)

    def post(self, request):
        payload = _json_body(request)
        context = tenant_context(request)
        flows = FinancialFlows()

        def operation():
            body, trade_id = flows.record_trade(context, payload)
            return body, 201, trade_id
        return _idempotent_json(request, context, "investments.trade", payload, operation)


class InvestmentDividendView(SafeView):
    def get(self, request):
        limit, offset = _pagination(request)
        return _list_response(_read(tenant_context(request), lambda repo: repo.list_dividends(limit, offset)), limit, offset)

    def post(self, request):
        payload = _json_body(request)
        context = tenant_context(request)
        flows = FinancialFlows()

        def operation():
            body, dividend_id = flows.record_dividend(context, payload)
            return body, 201, dividend_id
        return _idempotent_json(request, context, "investments.dividend", payload, operation)


class AssetValuationView(SafeView):
    def get(self, request, row_id):
        limit, offset = _pagination(request)
        rows = AssetService(HistoryRepository()).list_valuations(tenant_context(request), row_id, limit, offset)
        return JsonResponse({"results": serialize_rows(rows), "limit": limit, "offset": offset})

    def post(self, request, row_id):
        valuation_id = AssetService(HistoryRepository()).append_valuation(tenant_context(request), row_id, _json_body(request))
        return JsonResponse({"id": str(valuation_id)}, status=201)


class GoalContributionView(SafeView):
    def get(self, request, row_id):
        limit, offset = _pagination(request)
        rows = GoalService(PostgreSQLLedgerRepository(), HistoryRepository()).list_contributions(tenant_context(request), row_id, limit, offset)
        return JsonResponse({"results": serialize_rows(rows), "limit": limit, "offset": offset})

    def post(self, request, row_id):
        payload = _json_body(request)
        context = tenant_context(request)
        def operation():
            contribution_id = GoalService(PostgreSQLLedgerRepository(), HistoryRepository()).contribute(context, row_id, payload)
            return {"id": str(contribution_id)}, 201, contribution_id
        return _idempotent_json(request, context, "goals.contribution", payload | {"goal_id": str(row_id)}, operation)


class AuditListView(SafeView):
    def get(self, request):
        limit, offset = _pagination(request)
        rows = AuditService(AuditRepository()).list_events(tenant_context(request), request.GET.dict(), limit, offset)
        return JsonResponse({"results": serialize_rows(rows), "limit": limit, "offset": offset})


class SecurityAuditListView(SafeView):
    def get(self, request):
        limit, offset = _pagination(request)
        rows = AuditService(AuditRepository()).list_security_events(tenant_context(request), request.GET.dict(), limit, offset)
        return JsonResponse({"results": serialize_rows(rows), "limit": limit, "offset": offset})


class SecurityConfigStatusView(SafeView):
    def get(self, request):
        row = AuditService(AuditRepository()).security_config_status(tenant_context(request))
        return JsonResponse(serialize_row(row or {}))


class RecurringOccurrenceListView(SafeView):
    def get(self, request):
        limit, offset = _pagination(request)
        rows = RecurringService(RecurringRepository()).list_occurrences(tenant_context(request), limit, offset)
        return JsonResponse({"results": serialize_rows(rows), "limit": limit, "offset": offset})
