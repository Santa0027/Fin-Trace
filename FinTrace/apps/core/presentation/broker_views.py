import hmac
from urllib.parse import urlencode

from django.conf import settings
from django.http import HttpResponseRedirect, JsonResponse

from FinTrace.apps.core.application.broker import BrokerService
from FinTrace.apps.core.domain.exceptions import ApiError
from FinTrace.apps.core.infrastructure.database.utils import serialize_row
from FinTrace.apps.core.presentation.views import SafeView, tenant_context

STATE_KEY = "zerodha_login"


def _service() -> BrokerService:
    return BrokerService()


class BrokerPortfolioView(SafeView):
    """Connection status, holdings and metrics. Never includes the broker token."""

    def get(self, request):
        return JsonResponse(serialize_row(_service().portfolio(tenant_context(request))))


class BrokerAnalyticsView(SafeView):
    """The portfolio plus concentration, performance over time, SIPs, positions and observations."""

    def get(self, request):
        return JsonResponse(serialize_row(_service().analytics(tenant_context(request))))


class BrokerConnectView(SafeView):
    def post(self, request):
        context = tenant_context(request)
        login_url, state = _service().begin_login(context)
        # Bind the round trip to this browser session and this workspace.
        request.session[STATE_KEY] = {"state": state, "tenant_id": str(context.tenant_id)}
        return JsonResponse({"login_url": login_url})


class BrokerCallbackView(SafeView):
    """Where Zerodha sends the browser back. Always ends in a redirect to the app."""

    def get(self, request):
        def back(result: str, message: str = "") -> HttpResponseRedirect:
            query = {"broker": "zerodha", "result": result}
            if message:
                query["message"] = message[:200]
            separator = "&" if "?" in settings.FINTRACE_FRONTEND_URL else "?"
            return HttpResponseRedirect(f"{settings.FINTRACE_FRONTEND_URL}{separator}{urlencode(query)}")

        expected = request.session.pop(STATE_KEY, None)
        try:
            context = tenant_context(request)
        except ApiError as error:
            return back("error", error.message)
        state = request.GET.get("state", "")
        if not expected or not hmac.compare_digest(str(expected.get("state", "")), state) or expected.get("tenant_id") != str(context.tenant_id):
            return back("error", "This Zerodha sign-in did not start from your current session. Please try connecting again.")
        if request.GET.get("status") != "success" or not request.GET.get("request_token"):
            return back("cancelled", "Zerodha sign-in was cancelled.")
        try:
            _service().complete_login(context, request.GET["request_token"])
        except ApiError as error:
            return back("error", error.message)
        return back("connected")


class BrokerSyncView(SafeView):
    def post(self, request):
        return JsonResponse(serialize_row(_service().sync(tenant_context(request))))


class BrokerDisconnectView(SafeView):
    def post(self, request):
        context = tenant_context(request)
        _service().disconnect(context)
        return JsonResponse(serialize_row(_service().portfolio(context)))
