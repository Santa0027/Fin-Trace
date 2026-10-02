import pytest
from django.db import connection, transaction

@pytest.mark.integration
@pytest.mark.django_db
def test_runtime_security(context):
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)")
        row = cursor.fetchone()
        assert row[0] == "fintrace_app"
        assert row[1] is False
        assert row[2] is False

    with pytest.raises(Exception):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("DROP TABLE fintrace.accounts")
