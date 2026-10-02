from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

from django.db import connection, transaction


@contextmanager
def tenant_transaction(
    user_id: UUID | str,
    tenant_id: UUID | str,
    *,
    request_id: UUID | str | None = None,
    client_ip: str | None = None,
    user_agent: str | None = None,
) -> Iterator[None]:
    """Set PostgreSQL tenant/user context inside the same transaction as the work."""
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [str(user_id), str(tenant_id)])
            if request_id:
                cursor.execute("SELECT set_config('fintrace.request_id', %s, true)", [str(request_id)])
            if client_ip:
                cursor.execute("SELECT set_config('fintrace.client_ip', %s, true)", [client_ip])
            if user_agent:
                cursor.execute("SELECT set_config('fintrace.user_agent', %s, true)", [user_agent[:1000]])
        yield


def current_database_context() -> tuple[str | None, str | None]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT fintrace.current_user_id(), fintrace.current_tenant_id()")
        return cursor.fetchone()
