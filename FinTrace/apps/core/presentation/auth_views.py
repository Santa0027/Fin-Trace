from django.conf import settings
from django.contrib.auth import authenticate, get_user_model, login, logout, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.cache import cache
from django.http import JsonResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import ensure_csrf_cookie

from FinTrace.apps.core.application.parsing import json_body
from FinTrace.apps.core.domain.exceptions import ApiError, AuthenticationRequired, PermissionDenied, ValidationFailed
from FinTrace.apps.core.infrastructure.database.utils import DatabaseExecutor
from FinTrace.apps.core.presentation.exception_handlers import error_response, safe_view

LOGIN_MAX_FAILURES = getattr(settings, "FINTRACE_LOGIN_MAX_FAILURES", 5)
LOGIN_LOCKOUT_SECONDS = getattr(settings, "FINTRACE_LOGIN_LOCKOUT_SECONDS", 15 * 60)

class AuthView(View):
    @classmethod
    def as_view(cls, **initkwargs):
        return safe_view(super().as_view(**initkwargs))


def _require_user(request):
    if not getattr(request.user, "is_authenticated", False):
        raise AuthenticationRequired("Sign in to continue.")
    return request.user


def _companies(user, *, include_non_member: bool = False) -> list[dict]:
    """Workspaces for a user.

    tenants and memberships are invisible to the runtime role until a tenant
    context is set, so this goes through fintrace.list_user_tenants(), which
    returns only the given user's own active memberships.
    """
    return DatabaseExecutor().fetch_all(
        """
        SELECT id, slug, name, status, is_member,
               base_currency_id, base_currency_code, base_currency_symbol, base_currency_decimals, timezone
          FROM fintrace.list_user_tenants(%s::uuid, %s)
        """,
        [str(user.id), bool(include_non_member and user.is_superuser)],
    )


def _member_company(user, company_id) -> dict | None:
    return next((row for row in _companies(user) if str(row["id"]) == str(company_id)), None)


def _company_payload(company: dict) -> dict:
    """One shape for a workspace everywhere the API returns one."""
    return {
        "id": str(company["id"]),
        "company_id": str(company["id"]),
        "slug": company.get("slug"),
        "name": company["name"],
        "company_slug": company.get("slug"),
        "company_name": company["name"],
        "status": company.get("status", "ACTIVE"),
        "is_member": bool(company.get("is_member", True)),
        "timezone": company.get("timezone") or "UTC",
        "currency": {
            "id": str(company["base_currency_id"]),
            "code": company["base_currency_code"],
            "symbol": company["base_currency_symbol"],
            "decimal_places": company["base_currency_decimals"],
        },
    }


def _active_company(request, user) -> dict | None:
    """The session's workspace, but only while the user is still an active member of it."""
    active_id = request.session.get("active_company_id")
    if not active_id:
        return None
    company = _member_company(user, active_id)
    if company is None:
        request.session.pop("active_company_id", None)
    return company


def _session_payload(request, user) -> dict:
    company = _active_company(request, user)
    return {
        "authenticated": True,
        "user": {
            "id": str(user.id),
            "username": user.username,
            "email": user.email,
            "first_name": user.first_name,
            "last_name": user.last_name,
        },
        "tenant": _company_payload(company) if company else None,
        "platform": {"is_superuser": bool(user.is_superuser), "is_staff": bool(user.is_staff)},
    }


def _client_ip(request) -> str:
    return request.META.get("REMOTE_ADDR") or "unknown"


class LoginView(AuthView):
    @method_decorator(ensure_csrf_cookie)
    def post(self, request):
        data = json_body(request)
        identifier = str(data.get("email") or data.get("username") or "").strip()
        password = data.get("password")
        if not identifier or not password:
            raise ValidationFailed(
                {("password" if identifier else "email"): "Enter your email or username and your password."},
                code="INVALID_CREDENTIALS",
            )

        throttle_key = f"fintrace:login-failures:{_client_ip(request)}:{identifier.lower()}"
        if cache.get(throttle_key, 0) >= LOGIN_MAX_FAILURES:
            raise ApiError("Too many failed sign-in attempts. Try again in a few minutes.", code="TOO_MANY_ATTEMPTS", status=429)

        username = identifier
        if "@" in identifier:
            match = get_user_model().objects.filter(email__iexact=identifier).only("username").first()
            if match:
                username = match.username
        user = authenticate(request, username=username, password=str(password))
        if user is None:
            cache.set(throttle_key, cache.get(throttle_key, 0) + 1, LOGIN_LOCKOUT_SECONDS)
            raise ApiError("Incorrect email, username or password.", code="INVALID_CREDENTIALS", status=401)
        if not user.is_active:
            raise PermissionDenied("This user account is inactive.", code="INACTIVE_USER")

        cache.delete(throttle_key)
        login(request, user)
        if not _active_company(request, user):
            companies = _companies(user)
            if companies:
                request.session["active_company_id"] = str(companies[0]["id"])
        return JsonResponse(_session_payload(request, user))


class LogoutView(AuthView):
    def post(self, request):
        logout(request)
        return JsonResponse({"authenticated": False})


class MeView(AuthView):
    @method_decorator(ensure_csrf_cookie)
    def get(self, request):
        user = _require_user(request)
        return JsonResponse(_session_payload(request, user))


class CompaniesView(AuthView):
    def get(self, request):
        user = _require_user(request)
        # Platform admins also see that other workspaces exist (is_member = false),
        # but can only enter the ones they belong to; see docs/platform-admin-security.md.
        return JsonResponse({"companies": [_company_payload(row) for row in _companies(user, include_non_member=True)]})


class SwitchTenantView(AuthView):
    def post(self, request):
        user = _require_user(request)
        company_id = json_body(request).get("company_id")
        if not company_id:
            raise ValidationFailed({"company_id": "Choose a workspace."})
        company = _member_company(user, company_id)
        if company is None:
            raise PermissionDenied("You are not a member of this workspace, or it does not exist.", code="FORBIDDEN")
        request.session["active_company_id"] = str(company["id"])
        return JsonResponse({"tenant": _company_payload(company)})


class ChangePasswordView(AuthView):
    def post(self, request):
        user = _require_user(request)
        data = json_body(request)
        current, new = str(data.get("current_password") or ""), str(data.get("new_password") or "")
        if not user.check_password(current):
            raise ValidationFailed({"current_password": "Your current password is not correct."}, code="INVALID_CREDENTIALS")
        if current == new:
            raise ValidationFailed({"new_password": "Choose a password you have not just used."})
        try:
            validate_password(new, user)
        except ValidationError as exc:
            raise ValidationFailed({"new_password": " ".join(exc.messages)}) from None
        user.set_password(new)
        user.save(update_fields=["password"])
        # Other sessions for this user stop working; this one stays signed in.
        update_session_auth_hash(request, user)
        return JsonResponse({"status": "password_changed"})


class CsrfView(AuthView):
    @method_decorator(ensure_csrf_cookie)
    def get(self, request):
        return JsonResponse({"csrf": "ready"})


def csrf_failure(request, reason=""):
    """JSON instead of Django's HTML page, so the client can refresh its token and retry."""
    return error_response(403, "CSRF_FAILED", "Your session security token is missing or out of date. Refresh the page and try again.")
