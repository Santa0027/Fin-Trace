from decimal import Decimal
from uuid import uuid4

import pytest
from django.db import connection, transaction, utils

from tests.integration.helpers import admin_insert_account


def _create_posted_transaction(user_id, tenant_id, debit_account_id, credit_account_id, amount=Decimal("10.00"), reference="INT"):
    with connection.cursor() as cursor:
        cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [user_id, tenant_id])
        cursor.execute("SELECT fintrace.create_ledger_transaction(clock_timestamp(), %s, %s)", [reference, "integration test"])
        transaction_id = cursor.fetchone()[0]
        cursor.execute(
            "SELECT fintrace.add_ledger_entry(%s::uuid, %s::uuid, %s, 0, 1)",
            [transaction_id, debit_account_id, amount],
        )
        cursor.execute(
            "SELECT fintrace.add_ledger_entry(%s::uuid, %s::uuid, 0, %s, 1)",
            [transaction_id, credit_account_id, amount],
        )
        cursor.execute("SELECT fintrace.post_ledger_transaction(%s::uuid)", [transaction_id])
    return transaction_id


@pytest.mark.integration
@pytest.mark.django_db(transaction=True)
def test_rls_read_write_and_idor_account_isolation(context, admin_connection):
    tenant_a_account = admin_insert_account(
        admin_connection, context["tenant_a_id"], context["user_a_id"], context["currency_id"], f"tenant-a-{uuid4()}"
    )
    tenant_b_account = admin_insert_account(
        admin_connection, context["tenant_b_id"], context["user_b_id"], context["currency_id"], f"tenant-b-{uuid4()}"
    )

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [context["user_a_id"], context["tenant_a_id"]])
            cursor.execute("SELECT id FROM fintrace.accounts WHERE id = %s::uuid", [tenant_a_account])
            assert cursor.fetchone()[0] == tenant_a_account
            cursor.execute("SELECT id FROM fintrace.accounts WHERE id = %s::uuid", [tenant_b_account])
            assert cursor.fetchone() is None

            with pytest.raises(utils.DatabaseError):
                cursor.execute(
                    """
                    INSERT INTO fintrace.accounts
                        (tenant_id, name, type, normal_balance, currency_id)
                    VALUES (%s::uuid, %s, 'CASH', 'DEBIT', %s::uuid)
                    """,
                    [context["tenant_b_id"], "cross-tenant-write", context["currency_id"]],
                )


@pytest.mark.integration
@pytest.mark.django_db(transaction=True)
def test_ledger_balanced_unbalanced_reversal_and_transfer(context, admin_connection):
    cash = admin_insert_account(admin_connection, context["tenant_a_id"], context["user_a_id"], context["currency_id"], f"cash-{uuid4()}")
    clearing = admin_insert_account(admin_connection, context["tenant_a_id"], context["user_a_id"], context["currency_id"], f"clearing-{uuid4()}")
    destination = admin_insert_account(admin_connection, context["tenant_a_id"], context["user_a_id"], context["currency_id"], f"dest-{uuid4()}")

    with transaction.atomic():
        original_id = _create_posted_transaction(
            context["user_a_id"], context["tenant_a_id"], cash, clearing, Decimal("50.00"), "BALANCED"
        )
        with connection.cursor() as cursor:
            cursor.execute("SELECT status FROM fintrace.ledger_transactions WHERE id = %s::uuid", [original_id])
            assert cursor.fetchone()[0] == "COMPLETED"
            cursor.execute("SELECT COUNT(*) FROM fintrace.ledger_entries WHERE transaction_id = %s::uuid", [original_id])
            assert cursor.fetchone()[0] == 2

    with pytest.raises(utils.DatabaseError):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [context["user_a_id"], context["tenant_a_id"]])
                cursor.execute("SELECT fintrace.create_ledger_transaction(clock_timestamp(), 'UNBALANCED', 'bad')")
                unbalanced_id = cursor.fetchone()[0]
                cursor.execute("SELECT fintrace.add_ledger_entry(%s::uuid, %s::uuid, 5, 0, 1)", [unbalanced_id, cash])
                cursor.execute("SELECT fintrace.post_ledger_transaction(%s::uuid)", [unbalanced_id])

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [context["user_a_id"], context["tenant_a_id"]])
            cursor.execute("SELECT fintrace.reverse_ledger_transaction(%s::uuid, %s::uuid, clock_timestamp(), 'REV')", [context["tenant_a_id"], original_id])
            reversal_id = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM fintrace.ledger_entries WHERE transaction_id = %s::uuid", [reversal_id])
            assert cursor.fetchone()[0] == 2

    with transaction.atomic():
        transfer_id = _create_posted_transaction(
            context["user_a_id"], context["tenant_a_id"], destination, cash, Decimal("15.00"), "TRANSFER"
        )
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT account_id, balance_amount FROM fintrace.account_balances WHERE account_id IN (%s::uuid, %s::uuid)",
                [cash, destination],
            )
            balances = {row[0]: row[1] for row in cursor.fetchall()}
            assert balances[destination] == Decimal("15.00")
            assert balances[cash] == Decimal("-15.00000000")
            assert balances[destination] + balances[cash] == Decimal("0E-8")
            cursor.execute("SELECT description FROM fintrace.ledger_transactions WHERE id = %s::uuid", [transfer_id])
            assert cursor.fetchone()[0] == "integration test"
