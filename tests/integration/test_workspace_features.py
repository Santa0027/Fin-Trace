"""Recurring items, loan-payment reversal, cross-currency transfers, members, timezone and activity."""
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from io import StringIO
from uuid import uuid4

import pytest
from django.contrib.auth.hashers import make_password
from django.core.management import call_command
from django.core.management.base import CommandError

from FinTrace.apps.core.application.flows import FinancialFlows
from tests.integration.test_financial_flows import PERIOD, Workspace, call

pytestmark = [pytest.mark.integration, pytest.mark.django_db(transaction=True)]

TODAY = datetime.now(UTC).date()


@pytest.fixture
def fresh(context, admin_connection):
    """A brand-new workspace (base currency USD) with its own owner, so figures start from zero."""
    suffix = uuid4().hex[:8]
    user_id = uuid4()
    with admin_connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO fintrace.users (id, username, email, password_hash, first_name) VALUES (%s, %s, %s, %s, 'Owner')",
            [user_id, f"owner_{suffix}", f"owner_{suffix}@example.test", make_password("a-long-test-passphrase")],
        )
        cursor.execute("SELECT fintrace.provision_tenant(%s::uuid, %s, %s, %s::uuid)", [user_id, f"ws-{suffix}", "Fresh", context["currency_id"]])
        tenant_id = cursor.fetchone()[0]
        cursor.execute("SELECT code, id FROM fintrace.currencies WHERE code IN ('EUR', 'GBP')")
        currencies = dict(cursor.fetchall())
    admin_connection.commit()
    ws = Workspace({**context, "user_x_id": user_id, "tenant_x_id": tenant_id}, admin_connection, "x")
    ws.currencies = {code: str(value) for code, value in currencies.items()}
    ws.email = f"owner_{suffix}@example.test"
    return ws


def patch(ws, path, payload):
    return call("patch", path, ws.user_id, ws.tenant_id, payload)


# -- recurring ---------------------------------------------------------------

def _recurring(ws, **fields):
    response, body = ws.post("/api/v1/recurring-transactions/", {"frequency": "MONTHLY", "next_run_at": TODAY.isoformat(), **fields})
    assert response.status_code == 201, body
    return body


def test_recurring_expense_is_posted_once_and_moves_to_the_next_date(fresh):
    bank, rent = fresh.account(opening_balance="3000"), fresh.category("EXPENSE")
    item = _recurring(fresh, transaction_type="EXPENSE", description="Rent", amount="1200", source_account_id=bank["id"], category_id=rent)
    assert item["currency_id"] == str(fresh.context["currency_id"])  # derived from the account

    key = f"run-{uuid4()}"
    path = f"/api/v1/recurring-transactions/{item['id']}/run/"
    response, result = fresh.post(path, {}, key=key)
    assert response.status_code == 201, result
    assert result["scheduled_for"] == TODAY.isoformat() and result["ledger_transaction_id"]
    assert result["next_run_at"] == FinancialFlows.next_occurrence(TODAY, "MONTHLY", TODAY.day).isoformat()
    assert fresh.balance(bank["id"]) == Decimal("1800")

    # Pressing the button again (same key) replays; it does not post a second month's rent.
    response, replay = fresh.post(path, {}, key=key)
    assert response.status_code == 201 and replay == result
    assert fresh.balance(bank["id"]) == Decimal("1800")

    _, tx = fresh.get(f"/api/v1/transactions/{result['ledger_transaction_id']}/")
    assert tx["type"] == "EXPENSE" and tx["category_id"] == rent and tx["description"] == "Rent"
    _, listing = fresh.get("/api/v1/recurring-transactions/")
    row = next(r for r in listing["results"] if r["id"] == item["id"])
    assert row["last_status"] == "COMPLETED" and row["source_account_name"] == bank["name"] and row["category_name"]
    assert Decimal(fresh.summary()["totals"]["expenses"]) == Decimal("1200")


def test_recurring_skip_pause_and_missing_category(fresh):
    bank = fresh.account(opening_balance="500")
    item = _recurring(fresh, transaction_type="INCOME", description="Allowance", amount="50", destination_account_id=bank["id"])
    path = f"/api/v1/recurring-transactions/{item['id']}/run/"

    response, body = fresh.post(path, {})
    assert response.status_code == 400 and body["error"]["code"] == "CATEGORY_REQUIRED"
    assert fresh.balance(bank["id"]) == Decimal("500")  # nothing was posted

    response, skipped = fresh.post(path, {"action": "skip"})
    assert response.status_code == 201 and skipped["ledger_transaction_id"] is None
    assert skipped["next_run_at"] > TODAY.isoformat()
    assert fresh.balance(bank["id"]) == Decimal("500")

    assert patch(fresh, f"/api/v1/recurring-transactions/{item['id']}/", {"is_active": False})[0].status_code == 200
    response, body = fresh.post(path, {"action": "skip"})
    assert response.status_code == 409 and body["error"]["code"] == "RECURRING_PAUSED"


def test_recurring_worker_catches_up_and_reports_items_it_cannot_post(fresh):
    bank, savings, salary = fresh.account(opening_balance="1000"), fresh.account("Savings"), fresh.category("INCOME")
    two_weeks_ago = (TODAY - timedelta(days=14)).isoformat()
    transfer = _recurring(fresh, transaction_type="TRANSFER", description="Save", amount="100", frequency="WEEKLY",
                          source_account_id=bank["id"], destination_account_id=savings["id"], next_run_at=two_weeks_ago, start_date=two_weeks_ago)
    _recurring(fresh, transaction_type="INCOME", description="No category", amount="5", destination_account_id=bank["id"])
    _recurring(fresh, transaction_type="INCOME", description="Pay", amount="700", destination_account_id=bank["id"], category_id=salary)

    out, err = StringIO(), StringIO()
    with pytest.raises(CommandError, match="1 recurring item"):
        call_command("process_recurring_transactions", tenant_id=str(fresh.tenant_id), user_id=str(fresh.user_id), stdout=out, stderr=err)
    assert "4 posted, 1 could not be posted" in out.getvalue()  # three weekly transfers and the salary
    assert "Choose a category" in err.getvalue()
    assert fresh.balance(savings["id"]) == Decimal("300")
    assert fresh.balance(bank["id"]) == Decimal("1400")
    _, listing = fresh.get("/api/v1/recurring-transactions/")
    assert next(r for r in listing["results"] if r["id"] == transfer["id"])["next_run_at"] > TODAY.isoformat()

    # Running it again posts nothing new.
    with pytest.raises(CommandError):
        call_command("process_recurring_transactions", tenant_id=str(fresh.tenant_id), user_id=str(fresh.user_id), stdout=StringIO(), stderr=StringIO())
    assert fresh.balance(savings["id"]) == Decimal("300")


def test_monthly_schedule_keeps_its_day_across_short_months():
    step = FinancialFlows.next_occurrence
    from datetime import date
    assert step(date(2026, 1, 31), "MONTHLY", 31) == date(2026, 2, 28)
    assert step(date(2026, 2, 28), "MONTHLY", 31) == date(2026, 3, 31)
    assert step(date(2026, 12, 15), "MONTHLY", 15) == date(2027, 1, 15)
    assert step(date(2024, 2, 29), "YEARLY", 29) == date(2025, 2, 28)
    assert step(date(2026, 3, 1), "WEEKLY", 1) == date(2026, 3, 8)


# -- reversal of a loan repayment -------------------------------------------

def test_reversing_a_loan_repayment_restores_the_balance_and_reopens_the_loan(fresh):
    bank = fresh.account(opening_balance="1000")
    _, debt = fresh.post("/api/v1/debts/", {"type": "PAYABLE", "contact_name": "Bank", "principal_amount": "400"})
    path = f"/api/v1/debts/{debt['id']}/repayments/"
    _, payment = fresh.post(path, {"principal_amount": "400", "interest_amount": "10", "account_id": bank["id"]})
    assert payment["status"] == "PAID"
    assert fresh.balance(bank["id"]) == Decimal("590")

    response, body = fresh.post(f"/api/v1/transactions/{payment['ledger_transaction_id']}/reverse/", {"reference": "paid from the wrong account"})
    assert response.status_code == 201, body
    assert fresh.balance(bank["id"]) == Decimal("1000")
    _, detail = fresh.get(f"/api/v1/debts/{debt['id']}/")
    assert detail["status"] == "ACTIVE" and Decimal(detail["outstanding_principal"]) == Decimal("400")
    assert detail["repayment_count"] == 0 and Decimal(detail["interest_paid"]) == 0
    _, repayments = fresh.get(path)
    assert repayments["results"][0]["is_reversed"] is True  # history is kept, marked as reversed
    summary = fresh.summary()
    assert Decimal(summary["debts"]["payable"]) == Decimal("400")
    assert Decimal(summary["totals"]["expenses"]) == 0  # the interest expense was reversed too
    assert Decimal(summary["totals"]["liabilities"]) == Decimal("400")

    # The loan can be repaid again, correctly this time.
    response, again = fresh.post(path, {"principal_amount": "400", "account_id": bank["id"]})
    assert response.status_code == 201 and again["status"] == "PAID"
    _, issues = fresh.get("/api/v1/reports/data-integrity-issues/")
    assert issues["results"] == []


# -- cross-currency transfers ------------------------------------------------

def test_transfer_between_currencies_keeps_net_worth_and_is_not_income(fresh):
    usd = fresh.account("USD bank", opening_balance="1000")
    _, eur = fresh.post("/api/v1/accounts/", {"name": "EUR wallet", "type": "WALLET", "currency_id": fresh.currencies["EUR"]})
    _, gbp = fresh.post("/api/v1/accounts/", {"name": "GBP wallet", "type": "WALLET", "currency_id": fresh.currencies["GBP"]})
    before = fresh.summary()["totals"]

    response, body = fresh.post("/api/v1/transfers/", {"amount": "110", "from_account_id": usd["id"], "to_account_id": eur["id"]})
    assert response.status_code == 400 and body["error"]["code"] == "TO_AMOUNT_REQUIRED" and "to_amount" in body["error"]["fields"]

    response, sent = fresh.post("/api/v1/transfers/", {"amount": "110", "to_amount": "100", "from_account_id": usd["id"], "to_account_id": eur["id"]})
    assert response.status_code == 201, sent
    assert fresh.balance(usd["id"]) == Decimal("890") and fresh.balance(eur["id"]) == Decimal("100")
    after = fresh.summary()["totals"]
    assert after["net_worth"] == before["net_worth"] and after["income"] == before["income"] and after["expenses"] == before["expenses"]
    _, tx = fresh.get(f"/api/v1/transactions/{sent['id']}/")
    assert tx["type"] == "TRANSFER"

    # Back into the base currency, and between two foreign currencies (needs the sender's rate to base).
    assert fresh.post("/api/v1/transfers/", {"amount": "40", "to_amount": "44", "from_account_id": eur["id"], "to_account_id": usd["id"]})[0].status_code == 201
    response, body = fresh.post("/api/v1/transfers/", {"amount": "50", "to_amount": "43", "from_account_id": eur["id"], "to_account_id": gbp["id"]})
    assert response.status_code == 400 and body["error"]["code"] == "EXCHANGE_RATE_REQUIRED"
    response, body = fresh.post("/api/v1/transfers/", {"amount": "50", "to_amount": "43", "exchange_rate": "1.1", "from_account_id": eur["id"], "to_account_id": gbp["id"]})
    assert response.status_code == 201, body
    assert fresh.balance(eur["id"]) == Decimal("10") and fresh.balance(gbp["id"]) == Decimal("43") and fresh.balance(usd["id"]) == Decimal("934")
    assert fresh.summary()["totals"]["net_worth"] == before["net_worth"]
    assert fresh.get("/api/v1/reports/unbalanced-transactions/")[1]["results"] == []

    response, body = fresh.post("/api/v1/transfers/", {"amount": "5", "to_amount": "6", "from_account_id": usd["id"], "to_account_id": fresh.account("Other USD")["id"]})
    assert response.status_code == 400 and "to_amount" in body["error"]["fields"]


# -- members -----------------------------------------------------------------

def test_administrator_adds_a_member_changes_their_role_and_suspends_them(fresh, context):
    email = f"new_{uuid4().hex[:8]}@example.test"
    response, body = fresh.post("/api/v1/memberships/", {"email": email, "role": "VIEWER"})
    assert response.status_code == 400 and body["error"]["code"] == "PASSWORD_REQUIRED"
    response, body = fresh.post("/api/v1/memberships/", {"email": email, "role": "VIEWER", "password": "short"})
    assert response.status_code == 400 and "password" in body["error"]["fields"]

    response, added = fresh.post("/api/v1/memberships/", {"email": email, "role": "VIEWER", "password": "a-decent-temporary-pass", "first_name": "Nia"})
    assert response.status_code == 201, added
    assert added["created_user"] is True and "password" not in added
    response, body = fresh.post("/api/v1/memberships/", {"email": email.upper(), "role": "MEMBER"})
    assert response.status_code == 409 and body["error"]["code"] == "ALREADY_MEMBER"

    _, members = fresh.get("/api/v1/memberships/")
    by_email = {row["email"]: row for row in members["results"]}
    assert by_email[email]["role_codes"] == ["VIEWER"] and by_email[email]["is_owner"] is False
    assert by_email[fresh.email]["is_owner"] is True

    # The new member really is read-only, until promoted.
    account_payload = {"name": "Theirs", "type": "CASH", "currency_id": str(context["currency_id"])}
    assert call("get", "/api/v1/accounts/", added["user_id"], fresh.tenant_id)[0].status_code == 200
    assert call("post", "/api/v1/accounts/", added["user_id"], fresh.tenant_id, account_payload)[0].status_code == 403
    assert patch(fresh, f"/api/v1/memberships/{added['id']}/", {"role": "MEMBER"})[0].status_code == 200
    assert call("post", "/api/v1/accounts/", added["user_id"], fresh.tenant_id, account_payload)[0].status_code == 201

    # A member cannot manage members; nobody can change their own access or the owner's.
    response, _ = call("post", "/api/v1/memberships/", added["user_id"], fresh.tenant_id, {"email": "x@example.test", "password": "a-decent-temporary-pass"})
    assert response.status_code == 403
    response, body = patch(fresh, f"/api/v1/memberships/{by_email[fresh.email]['id']}/", {"role": "VIEWER"})
    assert response.status_code == 409 and body["error"]["code"] == "SELF_CHANGE"

    assert patch(fresh, f"/api/v1/memberships/{added['id']}/", {"status": "SUSPENDED"})[0].status_code == 200
    assert call("get", "/api/v1/accounts/", added["user_id"], fresh.tenant_id)[0].status_code == 403
    assert patch(fresh, f"/api/v1/memberships/{added['id']}/", {"status": "ACTIVE"})[0].status_code == 200
    assert call("get", "/api/v1/accounts/", added["user_id"], fresh.tenant_id)[0].status_code == 200

    # An existing FinTrace user is added without a password.
    response, existing = fresh.post("/api/v1/memberships/", {"email": "user_b@test.com", "role": "MEMBER"})
    assert response.status_code == 201 and existing["created_user"] is False


# -- timezone ----------------------------------------------------------------

def test_report_periods_follow_the_workspace_timezone(fresh):
    bank, food = fresh.account(opening_balance="100"), fresh.category("EXPENSE")
    # 20:00 UTC on 31 January is already 1 February in India.
    fresh.post("/api/v1/expenses/", {"amount": "25", "category_id": food, "source_account_id": bank["id"], "occurred_at": "2020-01-31T20:00:00Z"})
    january = "/api/v1/reports/spending-by-category/?date_from=2020-01-01&date_to=2020-01-31"
    february = "/api/v1/reports/spending-by-category/?date_from=2020-02-01&date_to=2020-02-29"
    assert Decimal(fresh.get(january)[1]["total"]) == Decimal("25")

    response, body = patch(fresh, f"/api/v1/tenants/{fresh.tenant_id}/", {"timezone": "Not/AZone"})
    assert response.status_code == 400 and "timezone" in body["error"]["message"].lower()
    response, body = patch(fresh, f"/api/v1/tenants/{fresh.tenant_id}/", {"timezone": "Asia/Kolkata"})
    assert response.status_code == 200 and body["timezone"] == "Asia/Kolkata"

    assert Decimal(fresh.get(january)[1]["total"]) == 0
    assert Decimal(fresh.get(february)[1]["total"]) == Decimal("25")
    _, cashflow = fresh.get("/api/v1/reports/cashflow/?months=2&date_to=2020-02-10")
    assert [(m["month"], Decimal(m["expenses"])) for m in cashflow["results"]] == [("Jan 2020", Decimal("0")), ("Feb 2020", Decimal("25"))]
    assert fresh.summary()["period"]["timezone"] == "Asia/Kolkata"

    # A date picked by the user stays on that date in the workspace's own calendar.
    _, expense = fresh.post("/api/v1/expenses/", {"amount": "5", "category_id": food, "source_account_id": bank["id"], "occurred_on": "2021-03-31"})
    march = "/api/v1/transactions/?date_from=2021-03-31&date_to=2021-03-31"
    assert [row["id"] for row in fresh.get(march)[1]["results"]] == [expense["ledger_transaction_id"]]
    assert fresh.get("/api/v1/transactions/?date_from=2021-04-01&date_to=2021-04-01")[1]["results"] == []


# -- activity ----------------------------------------------------------------

def test_activity_feed_names_who_did_what_without_exposing_row_snapshots(fresh):
    fresh.account("Audited")
    _, feed = fresh.get("/api/v1/activity/?limit=50")
    created = next(row for row in feed["results"] if row["entity_type"] == "accounts")
    assert created["actor_user_id"] == str(fresh.user_id) and created["actor_name"] == "Owner"
    assert "before_data" not in created and "after_data" not in created
    other = Workspace(fresh.context, fresh.admin_connection, "b")
    assert all(row["actor_user_id"] != str(fresh.user_id) for row in other.get("/api/v1/activity/?limit=50")[1]["results"])
