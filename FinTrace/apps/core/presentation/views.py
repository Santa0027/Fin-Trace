import json
from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid4

from django.conf import settings
from django.http import JsonResponse
from django.views import View

from FinTrace.apps.core.application.dto import CreateDebtRepaymentDTO, CreateExpenseDTO, CreateIncomeDTO, CreateLedgerTransactionDTO, LedgerEntryDTO, TenantContextDTO
from FinTrace.apps.core.application.services import CurrencyService, DebtService, ExpenseService, IdempotencyService, IncomeService, LedgerService, ReportingService, ResourceService, TenantService
from FinTrace.apps.core.infrastructure.database.utils import serialize_row, serialize_rows
from FinTrace.apps.core.infrastructure.repositories import DjangoCurrencyRepository, IdempotencyRepository, PostgreSQLFinancialMetadataRepository, PostgreSQLLedgerRepository, ReportingRepository, TenantResourceRepository
from FinTrace.apps.core.presentation.exception_handlers import safe_view


def _json_body(request) -> dict:
    return json.loads(request.body.decode("utf-8") or "{}")


def _pagination(request) -> tuple[int, int]:
    default = settings.FINTRACE_DEFAULT_PAGE_SIZE
    max_size = settings.FINTRACE_MAX_PAGE_SIZE
    limit = min(max(int(request.GET.get("limit", default)), 1), max_size)
    offset = max(int(request.GET.get("offset", 0)), 0)
    return limit, offset


def _client_ip(request) -> str | None:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.META.get("REMOTE_ADDR")


def tenant_context(request) -> TenantContextDTO:
    if not getattr(request.user, "is_authenticated", False):
        raise ValueError("Authentication is required.")
        
    tenant_id = request.session.get("active_company_id")
    if not tenant_id:
        raise ValueError("No active company context. Switch to a tenant first.")
        
    user_id = getattr(request.user, "id", None)
    if not user_id:
        raise ValueError("Authenticated user identity is required.")
        
    request_id = request.headers.get("X-Request-ID")
    return TenantContextDTO(
        user_id=UUID(str(user_id)),
        tenant_id=UUID(str(tenant_id)),
        request_id=UUID(str(request_id)) if request_id else uuid4(),

        client_ip=_client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", ""),
    )


def _idempotent_json(request, context: TenantContextDTO, scope: str, payload: dict, operation):
    key = request.headers.get("Idempotency-Key")
    if not key:
        return JsonResponse({"error": {"code": "IDEMPOTENCY_KEY_REQUIRED", "message": "Idempotency-Key header is required."}}, status=400)
    service = IdempotencyService(IdempotencyRepository())
    started = service.begin(context, scope, key, payload)
    op = started["operation"]
    if started["reuse"]:
        response_payload = op.get("response_payload") or {}
        if isinstance(response_payload, str):
            response_payload = json.loads(response_payload)
        return JsonResponse(response_payload, status=op.get("response_status") or 200)
    try:
        response_payload, status, business_id = operation()
    except Exception as exc:
        service.fail(context, op["id"], str(exc))
        raise
    service.complete(context, op["id"], business_id, status, response_payload)
    return JsonResponse(response_payload, status=status)


class SafeView(View):
    @classmethod
    def as_view(cls, **initkwargs):
        return safe_view(super().as_view(**initkwargs))


class CurrencyListView(SafeView):
    def get(self, request):
        currencies = CurrencyService(DjangoCurrencyRepository()).list_active_currencies()
        return JsonResponse({"results": [{**currency.__dict__, "id": str(currency.id)} for currency in currencies]})


class ResourceCollectionView(SafeView):
    resource = ""

    def _service(self):
        repository = TenantResourceRepository(self.resource)
        if self.resource == "tenants":
            return TenantService(repository)
        return ResourceService(repository)

    def get(self, request):
        limit, offset = _pagination(request)
        rows = self._service().list(tenant_context(request), limit, offset)
        return JsonResponse({"results": serialize_rows(rows), "limit": limit, "offset": offset})

    def post(self, request):
        row_id = self._service().create(tenant_context(request), _json_body(request))
        return JsonResponse({"id": str(row_id)}, status=201)


class ResourceDetailView(SafeView):
    resource = ""

    def _service(self):
        return ResourceService(TenantResourceRepository(self.resource))

    def get(self, request, row_id):
        row = self._service().get(tenant_context(request), row_id)
        if row is None:
            return JsonResponse({"error": {"code": "NOT_FOUND", "message": "Resource not found."}}, status=404)
        return JsonResponse(serialize_row(row))

    def patch(self, request, row_id):
        self._service().update(tenant_context(request), row_id, _json_body(request))
        return JsonResponse({"status": "updated"})


class ResourceArchiveView(SafeView):
    resource = ""

    def post(self, request, row_id):
        ResourceService(TenantResourceRepository(self.resource)).archive(tenant_context(request), row_id)
        return JsonResponse({"status": "archived"})


class LedgerTransactionView(SafeView):
    def get(self, request):
        limit, offset = _pagination(request)
        rows = LedgerService(PostgreSQLLedgerRepository()).list_transactions(tenant_context(request), limit, offset)
        return JsonResponse({"results": serialize_rows(rows), "limit": limit, "offset": offset})

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
        row = LedgerService(PostgreSQLLedgerRepository()).get_transaction(tenant_context(request), transaction_id)
        if row is None:
            return JsonResponse({"error": {"code": "NOT_FOUND", "message": "Transaction not found."}}, status=404)
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
        def operation():
            reversal_id = LedgerService(PostgreSQLLedgerRepository()).reverse_transaction(
                context,
                transaction_id,
                datetime.fromisoformat(payload["occurred_at"]),
                payload.get("reference", ""),
            )
            return {"id": str(reversal_id)}, 201, reversal_id
        return _idempotent_json(request, context, "ledger.reverse", payload | {"transaction_id": str(transaction_id)}, operation)


class IncomeCreateView(SafeView):
    def get(self, request):
        limit, offset = _pagination(request)
        rows = IncomeService(PostgreSQLLedgerRepository(), PostgreSQLFinancialMetadataRepository()).list_income(tenant_context(request), limit, offset)
        return JsonResponse({"results": serialize_rows(rows), "limit": limit, "offset": offset})

    def post(self, request):
        payload = _json_body(request)
        dto = CreateIncomeDTO(
            occurred_at=datetime.fromisoformat(payload["occurred_at"]),
            occurred_on=datetime.fromisoformat(payload["occurred_on"]).date(),
            destination_account_id=UUID(payload["destination_account_id"]),
            income_account_id=UUID(payload["income_account_id"]),
            category_id=UUID(payload["category_id"]),
            amount=Decimal(str(payload["amount"])),
            currency_id=UUID(payload["currency_id"]),
            contact_id=UUID(payload["contact_id"]) if payload.get("contact_id") else None,
            reference=payload.get("reference", ""),
            notes=payload.get("notes", ""),
        )
        context = tenant_context(request)
        def operation():
            tx_id = IncomeService(PostgreSQLLedgerRepository(), PostgreSQLFinancialMetadataRepository()).create_income(context, dto)
            return {"ledger_transaction_id": str(tx_id)}, 201, tx_id
        return _idempotent_json(request, context, "income.create", payload, operation)


class IncomeDetailView(SafeView):
    def get(self, request, row_id):
        row = IncomeService(PostgreSQLLedgerRepository(), PostgreSQLFinancialMetadataRepository()).get_income(tenant_context(request), row_id)
        if row is None:
            return JsonResponse({"error": {"code": "NOT_FOUND", "message": "Income record not found."}}, status=404)
        return JsonResponse(serialize_row(row))


class ExpenseCreateView(SafeView):
    def get(self, request):
        limit, offset = _pagination(request)
        rows = ExpenseService(PostgreSQLLedgerRepository(), PostgreSQLFinancialMetadataRepository()).list_expenses(tenant_context(request), limit, offset)
        return JsonResponse({"results": serialize_rows(rows), "limit": limit, "offset": offset})

    def post(self, request):
        payload = _json_body(request)
        dto = CreateExpenseDTO(
            occurred_at=datetime.fromisoformat(payload["occurred_at"]),
            occurred_on=datetime.fromisoformat(payload["occurred_on"]).date(),
            source_account_id=UUID(payload["source_account_id"]),
            expense_account_id=UUID(payload["expense_account_id"]),
            category_id=UUID(payload["category_id"]),
            amount=Decimal(str(payload["amount"])),
            currency_id=UUID(payload["currency_id"]),
            contact_id=UUID(payload["contact_id"]) if payload.get("contact_id") else None,
            reference=payload.get("reference", ""),
            notes=payload.get("notes", ""),
        )
        context = tenant_context(request)
        def operation():
            tx_id = ExpenseService(PostgreSQLLedgerRepository(), PostgreSQLFinancialMetadataRepository()).create_expense(context, dto)
            return {"ledger_transaction_id": str(tx_id)}, 201, tx_id
        return _idempotent_json(request, context, "expenses.create", payload, operation)


class ExpenseDetailView(SafeView):
    def get(self, request, row_id):
        row = ExpenseService(PostgreSQLLedgerRepository(), PostgreSQLFinancialMetadataRepository()).get_expense(tenant_context(request), row_id)
        if row is None:
            return JsonResponse({"error": {"code": "NOT_FOUND", "message": "Expense record not found."}}, status=404)
        return JsonResponse(serialize_row(row))


class DebtRepaymentView(SafeView):
    def post(self, request, row_id):
        payload = _json_body(request)
        dto = CreateDebtRepaymentDTO(
            debt_id=row_id,
            occurred_at=datetime.fromisoformat(payload["occurred_at"]),
            repaid_on=datetime.fromisoformat(payload["repaid_on"]).date(),
            liability_account_id=UUID(payload["liability_account_id"]),
            interest_expense_account_id=UUID(payload["interest_expense_account_id"]) if payload.get("interest_expense_account_id") else None,
            cash_account_id=UUID(payload["cash_account_id"]),
            principal_amount=Decimal(str(payload.get("principal_amount", "0"))),
            interest_amount=Decimal(str(payload.get("interest_amount", "0"))),
            reference=payload.get("reference", ""),
            notes=payload.get("notes", ""),
        )
        context = tenant_context(request)
        def operation():
            tx_id = DebtService(PostgreSQLLedgerRepository(), PostgreSQLFinancialMetadataRepository()).create_repayment(context, dto)
            return {"ledger_transaction_id": str(tx_id)}, 201, tx_id
        return _idempotent_json(request, context, "debts.repayment", payload | {"debt_id": str(row_id)}, operation)


class ReportView(SafeView):
    def get(self, request, report_name):
        limit, offset = _pagination(request)
        rows = ReportingService(ReportingRepository()).list_report(tenant_context(request), report_name, limit, offset)
        return JsonResponse({"results": serialize_rows(rows), "limit": limit, "offset": offset})

from FinTrace.apps.core.application.services import AuditService, AssetService, GoalService, InvestmentService, RBACService, RecurringService, TagService
from FinTrace.apps.core.infrastructure.repositories import AuditRepository, HistoryRepository, InvestmentRepository, RBACRepository, RecurringRepository, TagAssociationRepository


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
            return JsonResponse({"error": {"code": "METHOD_NOT_ALLOWED", "message": "This RBAC collection is read-only."}}, status=405)
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
    def post(self, request):
        payload = _json_body(request)
        context = tenant_context(request)
        def operation():
            trade_id = InvestmentService(PostgreSQLLedgerRepository(), InvestmentRepository()).create_trade(context, payload)
            return {"id": str(trade_id)}, 201, trade_id
        return _idempotent_json(request, context, "investments.trade", payload, operation)


class InvestmentDividendView(SafeView):
    def post(self, request):
        payload = _json_body(request)
        context = tenant_context(request)
        def operation():
            dividend_id = InvestmentService(PostgreSQLLedgerRepository(), InvestmentRepository()).create_dividend(context, payload)
            return {"id": str(dividend_id)}, 201, dividend_id
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
