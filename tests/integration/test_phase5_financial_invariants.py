from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from decimal import Decimal
import json
from uuid import uuid4

import pytest
from django.db import connection, transaction, utils

from FinTrace.apps.core.presentation.views import ExpenseCreateView, IncomeCreateView, LedgerReverseView
from tests.integration.helpers import admin_insert_account, admin_insert_category, authed_json_request


def _json(response):
    return json.loads(response.content.decode("utf-8"))


def _income_payload(context, cash_account_id, income_account_id, category_id, amount="25.00", reference=None):
    now = datetime.now(UTC)
    return {
        "occurred_at": now.isoformat(),
        "occurred_on": now.date().isoformat(),
        "destination_account_id": str(cash_account_id),
        "income_account_id": str(income_account_id),
        "category_id": str(category_id),
        "amount": amount,
        "currency_id": str(context["currency_id"]),
        "reference": reference or f"INC-{uuid4()}",
        "notes": "phase5 income",
    }


def _expense_payload(context, cash_account_id, expense_account_id, category_id, amount="10.00", reference=None):
    now = datetime.now(UTC)
    return {
        "occurred_at": now.isoformat(),
        "occurred_on": now.date().isoformat(),
        "source_account_id": str(cash_account_id),
        "expense_account_id": str(expense_account_id),
        "category_id": str(category_id),
        "amount": amount,
        "currency_id": str(context["currency_id"]),
        "reference": reference or f"EXP-{uuid4()}",
        "notes": "phase5 expense",
    }


def _post_income(context, payload, key):
    request = authed_json_request(
        "/api/v1/income/",
        payload,
        context["user_a_id"],
        context["tenant_a_id"],
        headers={"Idempotency-Key": key},
    )
    return IncomeCreateView.as_view()(request)


def _post_expense(context, payload, key):
    request = authed_json_request(
        "/api/v1/expenses/",
        payload,
        context["user_a_id"],
        context["tenant_a_id"],
        headers={"Idempotency-Key": key},
    )
    return ExpenseCreateView.as_view()(request)


def _ledger_count_for_reference(context, reference):
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [context["user_a_id"], context["tenant_a_id"]])
            cursor.execute("SELECT COUNT(*) FROM fintrace.ledger_transactions WHERE reference = %s", [reference])
            return cursor.fetchone()[0]


@pytest.fixture
def financial_accounts(context, admin_connection):
    cash = admin_insert_account(admin_connection, context["tenant_a_id"], context["user_a_id"], context["currency_id"], f"cash-{uuid4()}", "CASH", "DEBIT")
    income = admin_insert_account(admin_connection, context["tenant_a_id"], context["user_a_id"], context["currency_id"], f"income-{uuid4()}", "INCOME", "CREDIT")
    expense = admin_insert_account(admin_connection, context["tenant_a_id"], context["user_a_id"], context["currency_id"], f"expense-{uuid4()}", "EXPENSE", "DEBIT")
    income_category = admin_insert_category(admin_connection, context["tenant_a_id"], context["user_a_id"], f"income-cat-{uuid4()}", "INCOME")
    expense_category = admin_insert_category(admin_connection, context["tenant_a_id"], context["user_a_id"], f"expense-cat-{uuid4()}", "EXPENSE")
    return {
        "cash": cash,
        "income": income,
        "expense": expense,
        "income_category": income_category,
        "expense_category": expense_category,
    }


@pytest.mark.integration
@pytest.mark.django_db(transaction=True)
def test_posted_ledger_immutability_and_delete_protection(context, financial_accounts):
    payload = _income_payload(context, financial_accounts["cash"], financial_accounts["income"], financial_accounts["income_category"], "12.00")
    response = _post_income(context, payload, f"immutability-{uuid4()}")
    assert response.status_code == 201
    transaction_id = _json(response)["ledger_transaction_id"]

    with pytest.raises(utils.DatabaseError):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [context["user_a_id"], context["tenant_a_id"]])
                cursor.execute("UPDATE fintrace.ledger_transactions SET reference = 'MUTATED' WHERE id = %s::uuid", [transaction_id])

    with pytest.raises(utils.DatabaseError):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [context["user_a_id"], context["tenant_a_id"]])
                cursor.execute("UPDATE fintrace.ledger_entries SET debit_amount = 99 WHERE transaction_id = %s::uuid", [transaction_id])

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [context["user_a_id"], context["tenant_a_id"]])
            cursor.execute("DELETE FROM fintrace.ledger_entries WHERE transaction_id = %s::uuid", [transaction_id])
            assert cursor.rowcount == 0


@pytest.mark.integration
@pytest.mark.django_db(transaction=True)
def test_income_expense_idempotency_accounting_and_reversal(context, financial_accounts):
    income_ref = f"INC-IDEMP-{uuid4()}"
    income_payload = _income_payload(context, financial_accounts["cash"], financial_accounts["income"], financial_accounts["income_category"], "33.00", income_ref)
    key = f"income-key-{uuid4()}"
    first = _post_income(context, income_payload, key)
    second = _post_income(context, income_payload, key)
    assert first.status_code == 201
    assert second.status_code == 201
    assert _json(first) == _json(second)
    assert _ledger_count_for_reference(context, income_ref) == 1

    different = income_payload | {"amount": "34.00"}
    mismatch = _post_income(context, different, key)
    assert mismatch.status_code >= 400

    new_key = _post_income(context, income_payload | {"reference": f"{income_ref}-NEW"}, f"income-key-{uuid4()}")
    assert new_key.status_code == 201

    expense_ref = f"EXP-IDEMP-{uuid4()}"
    expense_payload = _expense_payload(context, financial_accounts["cash"], financial_accounts["expense"], financial_accounts["expense_category"], "8.00", expense_ref)
    expense_key = f"expense-key-{uuid4()}"
    expense_first = _post_expense(context, expense_payload, expense_key)
    expense_second = _post_expense(context, expense_payload, expense_key)
    assert expense_first.status_code == 201
    assert expense_second.status_code == 201
    assert _json(expense_first) == _json(expense_second)
    assert _ledger_count_for_reference(context, expense_ref) == 1

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [context["user_a_id"], context["tenant_a_id"]])
            cursor.execute("SELECT account_id, balance_amount FROM fintrace.account_balances WHERE account_id IN (%s::uuid, %s::uuid, %s::uuid)", [financial_accounts["cash"], financial_accounts["income"], financial_accounts["expense"]])
            balances = {row[0]: row[1] for row in cursor.fetchall()}
            assert balances[financial_accounts["cash"]] == Decimal("58.00000000")
            assert balances[financial_accounts["income"]] == Decimal("66.00000000")
            assert balances[financial_accounts["expense"]] == Decimal("8.00000000")

            cursor.execute("SELECT COUNT(*) FROM fintrace.income_records WHERE ledger_transaction_id = %s::uuid", [_json(first)["ledger_transaction_id"]])
            assert cursor.fetchone()[0] == 1
            cursor.execute("SELECT COUNT(*) FROM fintrace.expense_records WHERE ledger_transaction_id = %s::uuid", [_json(expense_first)["ledger_transaction_id"]])
            assert cursor.fetchone()[0] == 1

    reverse_request = authed_json_request(
        f"/api/v1/transactions/{_json(first)['ledger_transaction_id']}/reverse/",
        {"occurred_at": datetime.now(UTC).isoformat(), "reference": f"REV-{income_ref}"},
        context["user_a_id"],
        context["tenant_a_id"],
        headers={"Idempotency-Key": f"reverse-{uuid4()}"},
    )
    reverse_response = LedgerReverseView.as_view()(reverse_request, transaction_id=_json(first)["ledger_transaction_id"])
    assert reverse_response.status_code == 201

    expense_reverse_request = authed_json_request(
        f"/api/v1/transactions/{_json(expense_first)['ledger_transaction_id']}/reverse/",
        {"occurred_at": datetime.now(UTC).isoformat(), "reference": f"REV-{expense_ref}"},
        context["user_a_id"],
        context["tenant_a_id"],
        headers={"Idempotency-Key": f"reverse-expense-{uuid4()}"},
    )
    expense_reverse_response = LedgerReverseView.as_view()(expense_reverse_request, transaction_id=_json(expense_first)["ledger_transaction_id"])
    assert expense_reverse_response.status_code == 201


@pytest.mark.integration
@pytest.mark.django_db(transaction=True)
def test_idempotency_tenant_scoping(context, financial_accounts, admin_connection):
    tenant_b_cash = admin_insert_account(admin_connection, context["tenant_b_id"], context["user_b_id"], context["currency_id"], f"cash-b-{uuid4()}", "CASH", "DEBIT")
    tenant_b_income = admin_insert_account(admin_connection, context["tenant_b_id"], context["user_b_id"], context["currency_id"], f"income-b-{uuid4()}", "INCOME", "CREDIT")
    tenant_b_category = admin_insert_category(admin_connection, context["tenant_b_id"], context["user_b_id"], f"income-b-cat-{uuid4()}", "INCOME")
    key = f"tenant-scope-{uuid4()}"

    tenant_a_payload = _income_payload(context, financial_accounts["cash"], financial_accounts["income"], financial_accounts["income_category"], "5.00", f"A-{uuid4()}")
    tenant_b_payload = _income_payload(context, tenant_b_cash, tenant_b_income, tenant_b_category, "7.00", f"B-{uuid4()}")
    assert _post_income(context, tenant_a_payload, key).status_code == 201
    request_b = authed_json_request("/api/v1/income/", tenant_b_payload, context["user_b_id"], context["tenant_b_id"], headers={"Idempotency-Key": key})
    assert IncomeCreateView.as_view()(request_b).status_code == 201


@pytest.mark.integration
@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicate_income_and_double_reversal(context, financial_accounts):
    payload = _income_payload(context, financial_accounts["cash"], financial_accounts["income"], financial_accounts["income_category"], "11.00", f"CONC-{uuid4()}")
    key = f"concurrent-income-{uuid4()}"

    def submit_income():
        return _post_income(context, payload, key).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(lambda _: submit_income(), range(2)))

    assert statuses.count(201) == 1
    assert any(status >= 400 for status in statuses)
    assert _ledger_count_for_reference(context, payload["reference"]) == 1

    transaction_id = _json(_post_income(context, _income_payload(context, financial_accounts["cash"], financial_accounts["income"], financial_accounts["income_category"], "6.00"), f"rev-source-{uuid4()}"))["ledger_transaction_id"]

    def reverse_once():
        request = authed_json_request(
            f"/api/v1/transactions/{transaction_id}/reverse/",
            {"occurred_at": datetime.now(UTC).isoformat(), "reference": f"RACE-{uuid4()}"},
            context["user_a_id"],
            context["tenant_a_id"],
            headers={"Idempotency-Key": f"rev-race-{uuid4()}"},
        )
        return LedgerReverseView.as_view()(request, transaction_id=transaction_id).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        reverse_statuses = list(pool.map(lambda _: reverse_once(), range(2)))

    assert reverse_statuses.count(201) == 1
    assert any(status >= 400 for status in reverse_statuses)
