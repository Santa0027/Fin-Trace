"""Sign-in, session, CSRF and workspace switching through the real HTTP stack."""
from uuid import uuid4

import pytest
from django.contrib.auth.hashers import make_password
from django.core.cache import cache
from django.test import Client, override_settings

pytestmark = [pytest.mark.integration, pytest.mark.django_db(transaction=True)]

PASSWORD = "correct-horse-battery-staple"


@pytest.fixture
def member(context, admin_connection):
    """A real user with a password who administers their own fresh workspace."""
    suffix = uuid4().hex[:8]
    user_id = uuid4()
    with admin_connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO fintrace.users (id, username, email, password_hash, first_name, last_name) VALUES (%s, %s, %s, %s, 'Asha', 'Rao')",
            [user_id, f"asha_{suffix}", f"asha_{suffix}@example.test", make_password(PASSWORD)],
        )
        cursor.execute("SELECT fintrace.provision_tenant(%s::uuid, %s, %s, %s::uuid)", [user_id, f"home-{suffix}", "Home", context["currency_id"]])
        tenant_id = cursor.fetchone()[0]
    admin_connection.commit()
    cache.clear()
    return {"id": str(user_id), "username": f"asha_{suffix}", "email": f"asha_{suffix}@example.test", "tenant_id": str(tenant_id)}


@pytest.fixture
def browser():
    with override_settings(SESSION_ENGINE="django.contrib.sessions.backends.signed_cookies"):
        yield Client(enforce_csrf_checks=True)


def _csrf(client):
    client.get("/api/v1/auth/csrf/")
    return client.cookies["csrftoken"].value


def _post(client, path, payload, **headers):
    return client.post(path, data=payload, content_type="application/json", headers={"X-CSRFToken": _csrf(client), **headers})


def test_sign_in_session_and_sign_out(browser, member, context):
    response = browser.get("/api/v1/auth/me/")
    assert response.status_code == 401 and response.json()["error"]["code"] == "UNAUTHENTICATED"
    assert browser.get("/api/v1/accounts/").status_code == 401

    # State-changing requests without the CSRF token are refused, as JSON.
    response = browser.post("/api/v1/auth/login/", data={"email": member["email"], "password": PASSWORD}, content_type="application/json")
    assert response.status_code == 403 and response.json()["error"]["code"] == "CSRF_FAILED"

    response = _post(browser, "/api/v1/auth/login/", {"email": member["email"], "password": "wrong"})
    assert response.status_code == 401 and response.json()["error"]["code"] == "INVALID_CREDENTIALS"

    response = _post(browser, "/api/v1/auth/login/", {"email": member["email"].upper(), "password": PASSWORD})
    assert response.status_code == 200, response.content
    session = response.json()
    assert session["authenticated"] is True
    assert session["user"]["username"] == member["username"]
    assert session["tenant"]["company_id"] == member["tenant_id"] and session["tenant"]["company_name"] == "Home"
    assert "password" not in str(session).lower()

    assert browser.get("/api/v1/auth/me/").json()["tenant"]["id"] == member["tenant_id"]
    companies = browser.get("/api/v1/auth/companies/").json()["companies"]
    assert [row["id"] for row in companies] == [member["tenant_id"]]

    # The session carries the workspace: financial endpoints work without any tenant id from the client.
    assert browser.get("/api/v1/accounts/").json()["results"] == []
    permissions = {row["code"] for row in browser.get("/api/v1/rbac/effective-permissions/").json()["results"]}
    assert {"transactions.create", "dashboard.view", "accounts.create"} <= permissions
    members = browser.get("/api/v1/memberships/").json()["results"]
    assert [(row["email"], row["roles"]) for row in members] == [(member["email"], ["Administrator"])]
    assert "password_hash" not in members[0]

    # Switching to a workspace the user does not belong to is refused and changes nothing.
    response = _post(browser, "/api/v1/auth/switch-tenant/", {"company_id": str(context["tenant_a_id"])})
    assert response.status_code == 403
    assert browser.get("/api/v1/auth/me/").json()["tenant"]["id"] == member["tenant_id"]
    response = _post(browser, "/api/v1/auth/switch-tenant/", {"company_id": member["tenant_id"]})
    assert response.status_code == 200 and response.json()["tenant"]["company_id"] == member["tenant_id"]

    assert _post(browser, "/api/v1/auth/logout/", {}).status_code == 200
    assert browser.get("/api/v1/auth/me/").status_code == 401


def test_username_sign_in_and_lockout_after_repeated_failures(browser, member):
    assert _post(browser, "/api/v1/auth/login/", {"username": member["username"], "password": PASSWORD}).status_code == 200
    _post(browser, "/api/v1/auth/logout/", {})

    for _ in range(5):
        assert _post(browser, "/api/v1/auth/login/", {"username": member["username"], "password": "nope"}).status_code == 401
    response = _post(browser, "/api/v1/auth/login/", {"username": member["username"], "password": PASSWORD})
    assert response.status_code == 429 and response.json()["error"]["code"] == "TOO_MANY_ATTEMPTS"


def test_revoked_membership_drops_the_workspace_from_the_session(browser, member, admin_connection):
    suffix = uuid4().hex[:8]
    colleague_id = uuid4()
    with admin_connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO fintrace.users (id, username, email, password_hash) VALUES (%s, %s, %s, %s)",
            [colleague_id, f"ravi_{suffix}", f"ravi_{suffix}@example.test", make_password(PASSWORD)],
        )
        cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [member["id"], member["tenant_id"]])
        cursor.execute(
            "INSERT INTO fintrace.tenant_memberships (tenant_id, user_id, status, joined_at) VALUES (%s::uuid, %s::uuid, 'ACTIVE', clock_timestamp()) RETURNING id",
            [member["tenant_id"], colleague_id],
        )
        membership_id = cursor.fetchone()[0]
        cursor.execute(
            "INSERT INTO fintrace.rbac_membership_roles (membership_id, role_id) SELECT %s, id FROM fintrace.rbac_roles WHERE tenant_id IS NULL AND code = 'VIEWER'",
            [membership_id],
        )
    admin_connection.commit()

    assert _post(browser, "/api/v1/auth/login/", {"username": f"ravi_{suffix}", "password": PASSWORD}).status_code == 200
    assert browser.get("/api/v1/auth/me/").json()["tenant"]["id"] == member["tenant_id"]
    # A viewer can read but the database refuses writes, and the API reports that as 403.
    assert browser.get("/api/v1/accounts/").status_code == 200
    response = _post(browser, "/api/v1/accounts/", {"name": "Nope", "type": "BANK", "currency_id": str(uuid4())})
    assert response.status_code == 403 and response.json()["error"]["code"] == "PERMISSION_DENIED"

    with admin_connection.cursor() as cursor:
        cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [member["id"], member["tenant_id"]])
        cursor.execute("UPDATE fintrace.tenant_memberships SET status = 'SUSPENDED' WHERE id = %s", [membership_id])
    admin_connection.commit()

    assert browser.get("/api/v1/auth/me/").json()["tenant"] is None
    assert browser.get("/api/v1/auth/companies/").json()["companies"] == []
    response = browser.get("/api/v1/accounts/")
    assert response.status_code == 409 and response.json()["error"]["code"] == "NO_ACTIVE_TENANT"


def test_change_password_requires_the_current_one_and_takes_effect(browser, member):
    assert _post(browser, "/api/v1/auth/login/", {"username": member["username"], "password": PASSWORD}).status_code == 200
    new_password = "an-even-longer-new-passphrase"

    response = _post(browser, "/api/v1/auth/change-password/", {"current_password": "wrong", "new_password": new_password})
    assert response.status_code == 400 and "current_password" in response.json()["error"]["fields"]
    response = _post(browser, "/api/v1/auth/change-password/", {"current_password": PASSWORD, "new_password": "12345678"})
    assert response.status_code == 400 and "new_password" in response.json()["error"]["fields"]

    assert _post(browser, "/api/v1/auth/change-password/", {"current_password": PASSWORD, "new_password": new_password}).status_code == 200
    assert browser.get("/api/v1/auth/me/").status_code == 200  # this session stays signed in
    assert browser.get("/api/v1/auth/me/").json()["tenant"]["timezone"] == "UTC"

    _post(browser, "/api/v1/auth/logout/", {})
    assert _post(browser, "/api/v1/auth/login/", {"username": member["username"], "password": PASSWORD}).status_code == 401
    assert _post(browser, "/api/v1/auth/login/", {"username": member["username"], "password": new_password}).status_code == 200
