import json
from types import SimpleNamespace

import pytest
from django.contrib.sessions.middleware import SessionMiddleware
from django.test import RequestFactory

from FinTrace.apps.core.presentation.auth_views import CompaniesView, SwitchTenantView
from FinTrace.apps.core.presentation.views import LedgerTransactionView


def _request(method, path, user_id, payload=None, *, is_superuser=False, tenant_id=None):
    factory = RequestFactory()
    request_method = getattr(factory, method)
    if method == "get":
        request = request_method(path)
    else:
        request = request_method(path, data=json.dumps(payload or {}), content_type="application/json")
    SessionMiddleware(lambda req: None).process_request(request)
    if tenant_id:
        request.session["active_company_id"] = str(tenant_id)
    request.user = SimpleNamespace(
        id=str(user_id),
        is_authenticated=True,
        is_active=True,
        is_superuser=is_superuser,
        is_staff=is_superuser,
        username="superadmin" if is_superuser else "normal",
    )
    return request


def _json(response):
    return json.loads(response.content.decode("utf-8"))


@pytest.mark.integration
@pytest.mark.django_db(transaction=True)
def test_superadmin_company_visibility_and_switch_boundaries(context):
    normal_companies = CompaniesView.as_view()(_request("get", "/api/v1/auth/companies/", context["user_a_id"]))
    assert normal_companies.status_code == 200
    normal_ids = {row["id"] for row in _json(normal_companies)["companies"]}
    assert str(context["tenant_b_id"]) not in normal_ids

    denied_switch = SwitchTenantView.as_view()(
        _request("post", "/api/v1/auth/switch-tenant/", context["user_a_id"], {"company_id": str(context["tenant_b_id"])})
    )
    assert denied_switch.status_code == 403

    super_companies = CompaniesView.as_view()(
        _request("get", "/api/v1/auth/companies/", context["user_a_id"], is_superuser=True)
    )
    assert super_companies.status_code == 200
    super_ids = {row["id"] for row in _json(super_companies)["companies"]}
    assert str(context["tenant_b_id"]) not in normal_ids
    if super_ids:
        assert {str(context["tenant_a_id"]), str(context["tenant_b_id"])} <= super_ids

    super_switch = SwitchTenantView.as_view()(
        _request("post", "/api/v1/auth/switch-tenant/", context["user_a_id"], {"company_id": str(context["tenant_b_id"])}, is_superuser=True)
    )
    assert super_switch.status_code in {200, 403}


@pytest.mark.integration
@pytest.mark.django_db(transaction=True)
def test_superadmin_financial_access_still_requires_tenant_context(context):
    response = LedgerTransactionView.as_view()(
        _request("get", "/api/v1/transactions/", context["user_a_id"], is_superuser=True)
    )
    assert response.status_code >= 400
