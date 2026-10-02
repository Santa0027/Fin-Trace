import json
from types import SimpleNamespace
from uuid import uuid4

from django.contrib.sessions.middleware import SessionMiddleware
from django.test import RequestFactory


def admin_insert_account(admin_connection, tenant_id, user_id, currency_id, name, account_type="CASH", normal_balance="DEBIT"):
    account_id = uuid4()
    with admin_connection.cursor() as cursor:
        cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [str(user_id), str(tenant_id)])
        cursor.execute(
            """
            INSERT INTO fintrace.accounts
                (id, tenant_id, name, type, normal_balance, currency_id)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s::uuid)
            """,
            [account_id, tenant_id, name, account_type, normal_balance, currency_id],
        )
    admin_connection.commit()
    return account_id


def admin_insert_category(admin_connection, tenant_id, user_id, name, category_type):
    category_id = uuid4()
    with admin_connection.cursor() as cursor:
        cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [str(user_id), str(tenant_id)])
        cursor.execute(
            """
            INSERT INTO fintrace.categories (id, tenant_id, name, type)
            VALUES (%s::uuid, %s::uuid, %s, %s)
            """,
            [category_id, tenant_id, name, category_type],
        )
    admin_connection.commit()
    return category_id


def authed_json_request(path, payload, user_id, tenant_id, *, method="post", headers=None):
    factory = RequestFactory()
    request_method = getattr(factory, method)
    extra = {f"HTTP_{key.upper().replace('-', '_')}": value for key, value in (headers or {}).items()}
    request = request_method(path, data=json.dumps(payload), content_type="application/json", **extra)
    SessionMiddleware(lambda req: None).process_request(request)
    request.session["active_company_id"] = str(tenant_id)
    request.user = SimpleNamespace(
        id=str(user_id),
        is_authenticated=True,
        is_active=True,
        is_superuser=False,
        is_staff=False,
    )
    return request
