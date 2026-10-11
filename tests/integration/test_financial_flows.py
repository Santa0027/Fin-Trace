"""End-to-end checks of the human-level API flows against a real PostgreSQL ledger."""
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import pytest
from django.contrib.sessions.middleware import SessionMiddleware
from django.db import connection, transaction
from django.test import RequestFactory
from django.urls import resolve

from tests.integration.helpers import admin_insert_category

pytestmark = [pytest.mark.integration, pytest.mark.django_db(transaction=True)]

TODAY = datetime.now(UTC).date()
PERIOD = f"?date_from=2000-01-01&date_to={(TODAY + timedelta(days=1)).isoformat()}"


def call(method, path, user_id, tenant_id, payload=None, *, key=None, authenticated=True):
    factory = RequestFactory()
    headers = {"HTTP_IDEMPOTENCY_KEY": key} if key else {}
    if method == "get":
        request = factory.get(path, **headers)
    else:
        request = getattr(factory, method)(path, data=json.dumps(payload or {}), content_type="application/json", **headers)
    SessionMiddleware(lambda req: None).process_request(request)
    if tenant_id:
        request.session["active_company_id"] = str(tenant_id)
    request.user = SimpleNamespace(
        id=str(user_id), is_authenticated=authenticated, is_active=True, is_superuser=False, is_staff=False
    )
    match = resolve(path.split("?", 1)[0])
    response = match.func(request, **match.kwargs)
    body = json.loads(response.content.decode("utf-8")) if response.content else {}
    return response, body


class Workspace:
    """Tenant A acting through the API, with fresh accounts per test."""

    def __init__(self, context, admin_connection, tenant="a"):
        self.context = context
        self.user_id = context[f"user_{tenant}_id"]
        self.tenant_id = context[f"tenant_{tenant}_id"]
        self.admin_connection = admin_connection

    def get(self, path):
        return call("get", path, self.user_id, self.tenant_id)

    def post(self, path, payload=None, key=None):
        return call("post", path, self.user_id, self.tenant_id, payload, key=key or f"k-{uuid4()}")

    def account(self, name="Bank", account_type="BANK", **extra):
        response, body = self.post(
            "/api/v1/accounts/",
            {"name": f"{name} {uuid4().hex[:6]}", "type": account_type, "currency_id": str(self.context["currency_id"]), **extra},
        )
        assert response.status_code == 201, body
        return body

    def all_accounts(self):
        rows, offset = [], 0
        while True:
            _, body = self.get(f"/api/v1/accounts/?limit=200&offset={offset}")
            rows.extend(body["results"])
            if len(body["results"]) < 200:
                return rows
            offset += 200

    def category(self, category_type):
        return str(admin_insert_category(self.admin_connection, self.tenant_id, self.user_id, f"{category_type.title()} {uuid4().hex[:6]}", category_type))

    def balance(self, account_id):
        response, body = self.get(f"/api/v1/accounts/{account_id}/")
        assert response.status_code == 200, body
        return Decimal(body["balance_amount"])

    def summary(self):
        response, body = self.get(f"/api/v1/dashboard/summary/{PERIOD}")
        assert response.status_code == 200, body
        return body

    def fund(self, account_id, amount, category_id):
        response, body = self.post("/api/v1/income/", {"amount": amount, "category_id": category_id, "destination_account_id": account_id})
        assert response.status_code == 201, body
        return body


@pytest.fixture
def ws(context, admin_connection):
    return Workspace(context, admin_connection)


def _ledger_totals(tenant_id, user_id):
    """Income and expenses straight from ledger entries, bypassing the API read models."""
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [str(user_id), str(tenant_id)])
            cursor.execute(
                """
                SELECT COALESCE(sum(le.credit_amount - le.debit_amount) FILTER (WHERE a.type = 'INCOME'), 0),
                       COALESCE(sum(le.debit_amount - le.credit_amount) FILTER (WHERE a.type = 'EXPENSE'), 0),
                       COALESCE(sum(le.debit_amount), 0) - COALESCE(sum(le.credit_amount), 0)
                  FROM fintrace.ledger_entries le
                  JOIN fintrace.ledger_transactions lt ON lt.id = le.transaction_id
                  JOIN fintrace.accounts a ON a.id = le.account_id
                 WHERE lt.status = 'COMPLETED'
                """
            )
            return cursor.fetchone()


def test_income_expense_transfer_use_plain_language_payloads_and_post_to_the_ledger(ws):
    bank, wallet = ws.account("Bank"), ws.account("Wallet", "WALLET")
    assert bank["normal_balance"] == "DEBIT" and bank["category"] == "ASSET"
    salary, food = ws.category("INCOME"), ws.category("EXPENSE")
    before = ws.summary()["totals"]

    response, income = ws.post("/api/v1/income/", {"amount": "1000.00", "category_id": salary, "destination_account_id": bank["id"], "occurred_on": TODAY.isoformat(), "notes": "Salary"})
    assert response.status_code == 201, income
    response, expense = ws.post("/api/v1/expenses/", {"amount": "150.25", "category_id": food, "source_account_id": bank["id"]})
    assert response.status_code == 201, expense
    response, transfer = ws.post("/api/v1/transfers/", {"amount": "200", "from_account_id": bank["id"], "to_account_id": wallet["id"], "description": "Top up"})
    assert response.status_code == 201, transfer

    assert ws.balance(bank["id"]) == Decimal("649.75")
    assert ws.balance(wallet["id"]) == Decimal("200")

    after = ws.summary()["totals"]
    # The transfer moved money but is neither income nor spending.
    assert Decimal(after["income"]) - Decimal(before["income"]) == Decimal("1000")
    assert Decimal(after["expenses"]) - Decimal(before["expenses"]) == Decimal("150.25")
    assert Decimal(after["net_worth"]) - Decimal(before["net_worth"]) == Decimal("849.75")

    _, detail = ws.get(f"/api/v1/transactions/{transfer['id']}/")
    assert detail["type"] == "TRANSFER"
    assert detail["source_account_id"] == bank["id"] and detail["destination_account_id"] == wallet["id"]
    assert sum(Decimal(e["debit_amount"]) for e in detail["entries"]) == sum(Decimal(e["credit_amount"]) for e in detail["entries"])

    _, listing = ws.get("/api/v1/transactions/?type=INCOME,EXPENSE&limit=5")
    assert {row["type"] for row in listing["results"]} <= {"INCOME", "EXPENSE"}
    assert listing["total"] >= 2
    _, transfers = ws.get(f"/api/v1/transfers/?account_id={wallet['id']}")
    assert [row["id"] for row in transfers["results"]] == [transfer["id"]] and transfers["total"] == 1
    _, by_account = ws.get(f"/api/v1/transactions/?account_id={bank['id']}")
    assert {row["type"] for row in by_account["results"]} == {"INCOME", "EXPENSE", "TRANSFER"}

    _, detail = ws.get(f"/api/v1/income/{income['id']}/")
    assert detail["account_id"] == bank["id"] and detail["is_reversed"] is False
    _, incomes = ws.get("/api/v1/income/?limit=200")
    assert income["id"] in {row["id"] for row in incomes["results"]}


def test_dashboard_and_reports_reconcile_to_the_ledger(ws):
    bank = ws.account()
    salary, food, rent = ws.category("INCOME"), ws.category("EXPENSE"), ws.category("EXPENSE")
    ws.fund(bank["id"], "5000", salary)
    ws.post("/api/v1/expenses/", {"amount": "1200", "category_id": rent, "source_account_id": bank["id"]})
    _, mistaken = ws.post("/api/v1/expenses/", {"amount": "300", "category_id": food, "source_account_id": bank["id"]})
    response, _ = ws.post(f"/api/v1/transactions/{mistaken['ledger_transaction_id']}/reverse/", {})
    assert response.status_code == 201

    summary = ws.summary()
    _, spending = ws.get(f"/api/v1/reports/spending-by-category/{PERIOD}")
    _, earning = ws.get(f"/api/v1/reports/income-by-category/{PERIOD}")
    _, cashflow = ws.get(f"/api/v1/reports/cashflow/?months=36&date_to={(TODAY + timedelta(days=1)).isoformat()}")
    ledger_income, ledger_expenses, imbalance = _ledger_totals(ws.tenant_id, ws.user_id)

    assert imbalance == 0  # total debits equal total credits across the whole ledger
    assert Decimal(summary["totals"]["income"]) == ledger_income
    assert Decimal(summary["totals"]["expenses"]) == ledger_expenses
    assert Decimal(spending["total"]) == ledger_expenses == sum(Decimal(r["amount"]) for r in spending["results"])
    assert Decimal(earning["total"]) == ledger_income == sum(Decimal(r["amount"]) for r in earning["results"])
    assert summary["spending_by_category"] == {"total": spending["total"], "results": spending["results"]}
    assert sum(Decimal(m["expenses"]) for m in cashflow["results"]) <= ledger_expenses
    assert Decimal(cashflow["results"][-1]["income"]) == Decimal(summary["cashflow"][-1]["income"])

    # The reversed expense contributes nothing to its category.
    assert food not in {row["category_id"] for row in spending["results"]}
    assert Decimal(next(r["amount"] for r in spending["results"] if r["category_id"] == rent)) == Decimal("1200")
    assert ws.balance(bank["id"]) == Decimal("3800")
    _, issues = ws.get("/api/v1/reports/unbalanced-transactions/")
    assert issues["results"] == []


def test_reversal_preserves_history_and_cannot_be_repeated(ws):
    bank, food = ws.account(), ws.category("EXPENSE")
    ws.fund(bank["id"], "500", ws.category("INCOME"))
    _, expense = ws.post("/api/v1/expenses/", {"amount": "40", "category_id": food, "source_account_id": bank["id"]})
    tx_id = expense["ledger_transaction_id"]

    response, reversal = ws.post(f"/api/v1/transactions/{tx_id}/reverse/", {"reference": "wrong amount"})
    assert response.status_code == 201
    assert reversal["reverses_transaction_id"] == tx_id

    _, original = ws.get(f"/api/v1/transactions/{tx_id}/")
    assert original["status"] == "COMPLETED" and original["is_reversed"] is True
    assert original["reversed_by_transaction_id"] == reversal["id"]
    _, reversed_tx = ws.get(f"/api/v1/transactions/{reversal['id']}/")
    assert reversed_tx["type"] == "REVERSAL"
    assert ws.balance(bank["id"]) == Decimal("500")

    response, body = ws.post(f"/api/v1/transactions/{tx_id}/reverse/", {})
    assert response.status_code == 409, body
    assert body["error"]["message"] == "This transaction has already been reversed."

    response, body = ws.post(f"/api/v1/transactions/{reversal['id']}/reverse/", {})
    assert response.status_code == 409 and body["error"]["code"] == "REVERSAL_NOT_SUPPORTED", body


def test_idempotency_replays_same_request_and_rejects_a_different_one(ws):
    bank, salary = ws.account(), ws.category("INCOME")
    payload = {"amount": "75", "category_id": salary, "destination_account_id": bank["id"], "reference": f"IDEM-{uuid4()}"}
    key = f"idem-{uuid4()}"

    first_response, first = ws.post("/api/v1/income/", payload, key=key)
    second_response, second = ws.post("/api/v1/income/", payload, key=key)
    assert first_response.status_code == second_response.status_code == 201
    assert first == second
    assert second_response["Idempotent-Replayed"] == "true"
    assert ws.balance(bank["id"]) == Decimal("75")

    response, body = ws.post("/api/v1/income/", {**payload, "amount": "76"}, key=key)
    assert response.status_code == 409 and body["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"

    response, _ = ws.post("/api/v1/income/", payload, key=f"idem-{uuid4()}")
    assert response.status_code == 201  # a new key is a new, valid operation
    assert ws.balance(bank["id"]) == Decimal("150")

    response, body = call("post", "/api/v1/transfers/", ws.user_id, ws.tenant_id, {"amount": "1"})
    assert response.status_code == 400 and body["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_failed_submission_posts_nothing_and_its_key_can_be_retried(ws):
    bank, food = ws.account(), ws.category("EXPENSE")
    reference = f"ATOMIC-{uuid4()}"
    key = f"retry-{uuid4()}"
    bad = {"amount": "10", "category_id": food, "destination_account_id": bank["id"], "reference": reference}

    response, body = ws.post("/api/v1/income/", bad, key=key)  # an expense category on an income
    assert response.status_code == 400
    assert body["error"]["code"] == "VALIDATION_ERROR" and "category_id" in body["error"]["fields"]
    _, listing = ws.get(f"/api/v1/transactions/?q={reference}")
    assert listing["results"] == [] and listing["total"] == 0
    assert ws.balance(bank["id"]) == 0

    # The same key was never committed, so the identical retry is simply re-evaluated.
    response, _ = ws.post("/api/v1/income/", bad, key=key)
    assert response.status_code == 400


@pytest.mark.parametrize(
    ("mutate", "code", "field"),
    [
        (lambda p, a: p.update(to_account_id=a), "SAME_ACCOUNT", "to_account_id"),
        (lambda p, a: p.update(amount="0"), "VALIDATION_ERROR", "amount"),
        (lambda p, a: p.update(amount="-5"), "VALIDATION_ERROR", "amount"),
        (lambda p, a: p.update(amount="abc"), "VALIDATION_ERROR", "amount"),
        (lambda p, a: p.update(to_account_id=str(uuid4())), "VALIDATION_ERROR", "to_account_id"),
        (lambda p, a: p.pop("from_account_id"), "VALIDATION_ERROR", "from_account_id"),
    ],
)
def test_transfer_validation_errors_name_the_field(ws, mutate, code, field):
    bank, wallet = ws.account(), ws.account("Wallet", "WALLET")
    payload = {"amount": "10", "from_account_id": bank["id"], "to_account_id": wallet["id"]}
    mutate(payload, bank["id"])
    response, body = ws.post("/api/v1/transfers/", payload)
    assert response.status_code == 400, body
    assert body["error"]["code"] == code
    assert field in body["error"]["fields"]


def test_archived_account_cannot_receive_new_postings(ws):
    bank, wallet = ws.account(), ws.account("Wallet", "WALLET")
    response, _ = ws.post(f"/api/v1/accounts/{wallet['id']}/archive/")
    assert response.status_code == 200
    response, body = ws.post("/api/v1/transfers/", {"amount": "10", "from_account_id": bank["id"], "to_account_id": wallet["id"]})
    assert response.status_code == 400 and body["error"]["code"] == "ACCOUNT_INACTIVE"


def test_accounts_derive_accounting_attributes_and_book_opening_balances(ws):
    card = ws.account("Card", "CREDIT_CARD", opening_balance="250.00")
    assert card["normal_balance"] == "CREDIT" and card["category"] == "LIABILITY"
    assert Decimal(card["balance_amount"]) == Decimal("250")

    savings = ws.account("Savings", "BANK", opening_balance="1000")
    assert ws.balance(savings["id"]) == Decimal("1000")

    response, body = ws.post("/api/v1/accounts/", {"name": "Bad", "type": "BANK", "normal_balance": "CREDIT", "currency_id": str(ws.context["currency_id"])})
    assert response.status_code == 400 and "normal_balance" in body["error"]["fields"]
    response, body = ws.post("/api/v1/accounts/", {"name": "Bad", "type": "INCOME", "currency_id": str(ws.context["currency_id"])})
    assert response.status_code == 400 and "type" in body["error"]["fields"]

    system = [row for row in ws.all_accounts() if row["is_system"]]
    assert system and all(not row["is_payment_account"] for row in system)
    opening = [row for row in system if row["name"] == "Opening balances"]
    assert len(opening) == 1  # found-or-created once, not once per account
    response, body = call("patch", f"/api/v1/accounts/{opening[0]['id']}/", ws.user_id, ws.tenant_id, {"name": "Mine"})
    assert response.status_code == 409 and body["error"]["code"] == "SYSTEM_RECORD"


def test_authentication_and_workspace_are_required(ws):
    response, body = call("get", "/api/v1/accounts/", ws.user_id, ws.tenant_id, authenticated=False)
    assert response.status_code == 401 and body["error"]["code"] == "UNAUTHENTICATED"
    response, body = call("get", "/api/v1/accounts/", ws.user_id, None)
    assert response.status_code == 409 and body["error"]["code"] == "NO_ACTIVE_TENANT"
    response, body = call("post", "/api/v1/income/", ws.user_id, ws.tenant_id, None, key="k")
    assert response.status_code == 400  # empty body is a validation error, not a server error
    request_path = "/api/v1/transactions/?limit=abc"
    response, body = call("get", request_path, ws.user_id, ws.tenant_id)
    assert response.status_code == 400 and body["error"]["code"] == "VALIDATION_ERROR"


def test_tenants_cannot_see_or_use_each_others_financial_data(context, admin_connection):
    a = Workspace(context, admin_connection, "a")
    b = Workspace(context, admin_connection, "b")
    a_bank, b_bank = a.account("A bank"), b.account("B bank")
    a.fund(a_bank["id"], "900", a.category("INCOME"))
    reference = f"ISO-{uuid4()}"
    _, a_expense = a.post("/api/v1/expenses/", {"amount": "5", "category_id": a.category("EXPENSE"), "source_account_id": a_bank["id"], "reference": reference})

    # Tenant B cannot read tenant A's rows by id ...
    assert b.get(f"/api/v1/accounts/{a_bank['id']}/")[0].status_code == 404
    assert b.get(f"/api/v1/transactions/{a_expense['ledger_transaction_id']}/")[0].status_code == 404
    assert b.get(f"/api/v1/transactions/?q={reference}")[1]["results"] == []
    assert a_bank["id"] not in {row["id"] for row in b.all_accounts()}
    assert b_bank["id"] in {row["id"] for row in b.all_accounts()}

    # ... nor move money through them, reverse them, or reuse A's categories.
    response, body = b.post("/api/v1/transfers/", {"amount": "1", "from_account_id": a_bank["id"], "to_account_id": b_bank["id"]})
    assert response.status_code == 400 and "from_account_id" in body["error"]["fields"]
    response, _ = b.post(f"/api/v1/transactions/{a_expense['ledger_transaction_id']}/reverse/", {})
    assert response.status_code == 404  # as far as tenant B can tell, it does not exist
    assert a.balance(a_bank["id"]) == Decimal("895")

    # A user who is not a member cannot enter the tenant at all, even with its id in the session.
    response, body = call("get", "/api/v1/accounts/", context["user_b_id"], context["tenant_a_id"])
    assert response.status_code == 403 and body["error"]["code"] == "PERMISSION_DENIED"
    response, body = call("get", f"/api/v1/dashboard/summary/{PERIOD}", context["user_b_id"], context["tenant_a_id"])
    assert response.status_code == 403

    # An idempotency key used by tenant A is independent in tenant B.
    key = f"shared-{uuid4()}"
    assert a.post("/api/v1/income/", {"amount": "1", "category_id": a.category("INCOME"), "destination_account_id": a_bank["id"]}, key=key)[0].status_code == 201
    assert b.post("/api/v1/income/", {"amount": "1", "category_id": b.category("INCOME"), "destination_account_id": b_bank["id"]}, key=key)[0].status_code == 201


def test_debt_lifecycle_books_the_liability_and_settles_it(ws):
    bank = ws.account()
    before = ws.summary()
    response, debt = ws.post("/api/v1/debts/", {"type": "PAYABLE", "contact_name": f"Lender {uuid4().hex[:6]}", "principal_amount": "1000", "interest_rate": "8.5", "account_id": bank["id"]})
    assert response.status_code == 201, debt
    assert ws.balance(bank["id"]) == Decimal("1000")  # the borrowed money arrived
    mid = ws.summary()
    assert Decimal(mid["totals"]["liabilities"]) - Decimal(before["totals"]["liabilities"]) == Decimal("1000")
    assert Decimal(mid["totals"]["net_worth"]) == Decimal(before["totals"]["net_worth"])  # borrowing is not income
    assert Decimal(mid["totals"]["income"]) == Decimal(before["totals"]["income"])
    assert Decimal(mid["debts"]["payable"]) - Decimal(before["debts"]["payable"]) == Decimal("1000")

    path = f"/api/v1/debts/{debt['id']}/repayments/"
    response, body = ws.post(path, {"principal_amount": "1500", "account_id": bank["id"]})
    assert response.status_code == 400 and body["error"]["code"] == "EXCEEDS_OUTSTANDING"

    response, repayment = ws.post(path, {"principal_amount": "400", "interest_amount": "25", "account_id": bank["id"]})
    assert response.status_code == 201, repayment
    assert repayment["outstanding_principal"] == "600" and repayment["status"] == "ACTIVE"
    assert ws.balance(bank["id"]) == Decimal("575")
    after = ws.summary()
    assert Decimal(after["totals"]["expenses"]) - Decimal(mid["totals"]["expenses"]) == Decimal("25")  # only interest is spending

    response, final = ws.post(path, {"amount": "600", "account_id": bank["id"]})
    assert response.status_code == 201, final
    assert final["status"] == "PAID"
    _, detail = ws.get(f"/api/v1/debts/{debt['id']}/")
    assert detail["status"] == "PAID" and Decimal(detail["outstanding_principal"]) == 0
    assert Decimal(detail["interest_paid"]) == Decimal("25") and detail["repayment_count"] == 2
    _, repayments = ws.get(path)
    assert len(repayments["results"]) == 2
    response, body = ws.post(path, {"amount": "1", "account_id": bank["id"]})
    assert response.status_code == 409 and body["error"]["code"] == "DEBT_NOT_ACTIVE"
    assert Decimal(ws.summary()["totals"]["liabilities"]) == Decimal(before["totals"]["liabilities"])


def test_investment_buy_sell_and_dividend_flow_through_the_ledger(ws):
    bank = ws.account(opening_balance="10000")
    symbol = f"T{uuid4().hex[:5].upper()}"
    before = ws.summary()

    response, buy = ws.post("/api/v1/investments/trades/", {"trade_type": "BUY", "symbol": symbol, "quantity": "10", "price": "100", "fees": "5", "settlement_account_id": bank["id"]})
    assert response.status_code == 201, buy
    assert ws.balance(bank["id"]) == Decimal("8995")
    _, holdings = ws.get("/api/v1/reports/investment-position-summary/?limit=200")
    holding = next(row for row in holdings["results"] if row["symbol"] == symbol)
    assert Decimal(holding["quantity"]) == 10 and Decimal(holding["cost_value"]) == Decimal("1005")
    assert Decimal(ws.summary()["totals"]["net_worth"]) == Decimal(before["totals"]["net_worth"])  # cash became an asset

    response, body = ws.post("/api/v1/investments/trades/", {"trade_type": "SELL", "symbol": symbol, "quantity": "11", "price": "120", "settlement_account_id": bank["id"]})
    assert response.status_code == 400 and body["error"]["code"] == "INSUFFICIENT_HOLDING"

    response, sell = ws.post("/api/v1/investments/trades/", {"trade_type": "SELL", "symbol": symbol, "quantity": "4", "price": "120", "settlement_account_id": bank["id"]})
    assert response.status_code == 201, sell
    assert ws.balance(bank["id"]) == Decimal("9475")
    _, trades = ws.get("/api/v1/investments/trades/?limit=2")
    assert trades["results"][0]["trade_type"] == "SELL"
    assert Decimal(trades["results"][0]["realized_pnl"]) == Decimal("78")  # (120 - 100.5) * 4

    response, dividend = ws.post("/api/v1/investments/dividends/", {"symbol": symbol, "amount": "12.50", "deposit_account_id": bank["id"]})
    assert response.status_code == 201, dividend
    after = ws.summary()
    assert Decimal(after["totals"]["income"]) - Decimal(before["totals"]["income"]) == Decimal("90.50")  # gain + dividend
    assert _ledger_totals(ws.tenant_id, ws.user_id)[2] == 0
    _, detail = ws.get(f"/api/v1/transactions/{sell['ledger_transaction_id']}/")
    assert detail["type"] == "INVESTMENT_SELL"

    # A trade is corrected with the opposite trade, never a reversal; a dividend can be reversed.
    response, body = ws.post(f"/api/v1/transactions/{sell['ledger_transaction_id']}/reverse/", {})
    assert response.status_code == 409 and body["error"]["code"] == "REVERSAL_NOT_SUPPORTED"
    response, _ = ws.post(f"/api/v1/transactions/{dividend['ledger_transaction_id']}/reverse/", {})
    assert response.status_code == 201
    assert ws.balance(bank["id"]) == Decimal("9475")
    _, dividends = ws.get("/api/v1/investments/dividends/?limit=200")
    assert next(row for row in dividends["results"] if row["id"] == dividend["id"])["is_reversed"] is True
    assert Decimal(ws.summary()["totals"]["income"]) - Decimal(before["totals"]["income"]) == Decimal("78")
