import pytest
from django.db import transaction
from django.db import connection, utils

@pytest.mark.integration
@pytest.mark.django_db
def test_tenant_isolation(context):
    with connection.cursor() as cursor:
        cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [context["user_a_id"], context["tenant_a_id"]])
        # test 2
        with pytest.raises(utils.ProgrammingError):
            cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [context["user_a_id"], context["tenant_b_id"]])

@pytest.mark.integration
@pytest.mark.django_db(transaction=True)
def test_same_connection_leakage(context):
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_user")
        assert cursor.fetchone()[0] == "fintrace_app"

        with transaction.atomic():
            cursor.execute("SELECT fintrace.set_context(%s, %s)", [context["user_a_id"], context["tenant_a_id"]])
            cursor.execute("SELECT current_setting('fintrace.current_tenant_id', true)")
            assert cursor.fetchone()[0] == str(context["tenant_a_id"])
            
        cursor.execute("SELECT current_setting('fintrace.current_tenant_id', true)")
        assert cursor.fetchone()[0] == ''
        
        with transaction.atomic():
            cursor.execute("SELECT fintrace.set_context(%s, %s)", [context["user_b_id"], context["tenant_b_id"]])
            cursor.execute("SELECT current_setting('fintrace.current_tenant_id', true)")
            assert cursor.fetchone()[0] == str(context["tenant_b_id"])

        cursor.execute("SELECT current_setting('fintrace.current_tenant_id', true)")
        assert cursor.fetchone()[0] == ''
