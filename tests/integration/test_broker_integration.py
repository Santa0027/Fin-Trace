"""Zerodha (Kite + Coin) connection, exercised against a fake of Zerodha's HTTP API."""
import hashlib
import json
from decimal import Decimal
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest
from django.contrib.auth.hashers import make_password
from django.contrib.sessions.middleware import SessionMiddleware
from django.db import connection, transaction
from django.test import RequestFactory
from django.urls import resolve

from FinTrace.apps.core.application.broker import BrokerService
from FinTrace.apps.core.infrastructure.kite_client import KiteClient
from FinTrace.apps.core.presentation import broker_views
from tests.integration.test_financial_flows import Workspace

pytestmark = [pytest.mark.integration, pytest.mark.django_db(transaction=True)]

API_KEY, API_SECRET, ACCESS_TOKEN = "test_api_key", "test_api_secret", "kite-access-token-for-tests"
BASE = "/api/v1/integrations/zerodha"

# Shaped like Kite's real responses, floats included.
EQUITY = [
    {"tradingsymbol": "INFY", "exchange": "NSE", "isin": "INE009A01021", "quantity": 10, "t1_quantity": 2, "average_price": 1400.1, "last_price": 1520.35, "close_price": 1500.0, "pnl": 1443.0},
    {"tradingsymbol": "TATAMOTORS", "exchange": "NSE", "isin": "INE155A01022", "quantity": 20, "t1_quantity": 0, "average_price": 950.0, "last_price": 900.5, "close_price": 910.0, "pnl": -990.0},
    {"tradingsymbol": "SOLDOUT", "exchange": "NSE", "isin": "X", "quantity": 0, "t1_quantity": 0, "average_price": 10.0, "last_price": 12.0, "close_price": 11.0, "pnl": 0},
]
FUNDS = [
    {"folio": "123456/78", "fund": "Parag Parikh Flexi Cap Fund - Direct Plan", "tradingsymbol": "INF879O01027", "average_price": 55.123, "last_price": 72.4567, "pnl": 1733.44, "quantity": 100.003},
]


POSITIONS = {"net": [
    {"tradingsymbol": "NIFTY26OCTFUT", "exchange": "NFO", "product": "NRML", "quantity": 50, "average_price": 24850.5, "last_price": 24910.0, "pnl": 2975.0},
    {"tradingsymbol": "SBIN", "exchange": "NSE", "product": "MIS", "quantity": 0, "average_price": 0, "last_price": 812.0, "pnl": 140.0},
], "day": []}
SIPS = [
    {"sip_id": "S1", "fund": "Parag Parikh Flexi Cap Fund - Direct Plan", "tradingsymbol": "INF879O01027", "status": "ACTIVE", "frequency": "monthly",
     "instalment_amount": 5000.0, "instalment_day": 5, "next_instalment": "2099-01-05", "completed_instalments": 14, "pending_instalments": -1},
    {"sip_id": "S2", "fund": "Some Weekly Fund", "tradingsymbol": "INF000000001", "status": "ACTIVE", "frequency": "weekly",
     "instalment_amount": 500.0, "instalment_day": 0, "next_instalment": "2099-01-02 00:00:00", "completed_instalments": 3, "pending_instalments": 49},
    {"sip_id": "S3", "fund": "Paused Fund", "tradingsymbol": "INF000000002", "status": "PAUSED", "frequency": "monthly", "instalment_amount": 9999.0},
]
MARGINS = {"equity": {"enabled": True, "net": 15250.75, "available": {"cash": 15000.0, "live_balance": 15250.75, "collateral": 0}}, "commodity": {"enabled": False}}


class FakeKite:
    """Stands in for api.kite.trade and records what FinTrace sent."""

    def __init__(self):
        self.calls = []
        self.mode = "ok"
        self.equity, self.funds = EQUITY, FUNDS
        self.unavailable: set[str] = set()

    def __call__(self, method, url, headers, data):
        path = urlparse(url).path
        self.calls.append((method, path, headers, data))
        if path == "/session/token" and method == "POST":
            form = {k: v[0] for k, v in parse_qs(data.decode()).items()}
            expected = hashlib.sha256(f"{API_KEY}{form['request_token']}{API_SECRET}".encode()).hexdigest()
            if form["checksum"] != expected or form["request_token"] != "good-request-token":
                return 403, json.dumps({"status": "error", "error_type": "TokenException", "message": "Token is invalid or has expired."}).encode()
            return 200, json.dumps({"status": "success", "data": {"user_id": "AB1234", "user_name": "Asha Rao", "access_token": ACCESS_TOKEN}}).encode()
        if path == "/session/token" and method == "DELETE":
            return 200, json.dumps({"status": "success", "data": True}).encode()
        if self.mode == "expired" or headers.get("Authorization") != f"token {API_KEY}:{ACCESS_TOKEN}":
            return 403, json.dumps({"status": "error", "error_type": "TokenException", "message": "Incorrect `api_key` or `access_token`."}).encode()
        if self.mode == "down":
            return 503, b"<html>Service unavailable</html>"
        if path in self.unavailable:
            return 400, json.dumps({"status": "error", "error_type": "PermissionException", "message": "Insufficient permission for that call."}).encode()
        payload = {"/portfolio/holdings": self.equity, "/mf/holdings": self.funds, "/portfolio/positions": POSITIONS, "/mf/sips": SIPS, "/user/margins": MARGINS}[path]
        return 200, json.dumps({"status": "success", "data": payload}).encode()


@pytest.fixture
def kite(monkeypatch, settings):
    settings.KITE_API_KEY, settings.KITE_API_SECRET = API_KEY, API_SECRET
    fake = FakeKite()
    monkeypatch.setattr(broker_views, "_service", lambda: BrokerService(KiteClient(API_KEY, API_SECRET, transport=fake)))
    return fake


@pytest.fixture
def fresh(context, admin_connection):
    suffix = uuid4().hex[:8]
    user_id = uuid4()
    with admin_connection.cursor() as cursor:
        cursor.execute("INSERT INTO fintrace.users (id, username, email, password_hash, first_name) VALUES (%s, %s, %s, %s, 'Owner')",
                       [user_id, f"inv_{suffix}", f"inv_{suffix}@example.test", make_password("a-long-test-passphrase")])
        cursor.execute("SELECT fintrace.provision_tenant(%s::uuid, %s, %s, %s::uuid)", [user_id, f"inv-{suffix}", "Investor", context["currency_id"]])
        tenant_id = cursor.fetchone()[0]
    admin_connection.commit()
    return Workspace({**context, "user_x_id": user_id, "tenant_x_id": tenant_id}, admin_connection, "x")


def stored_token(workspace):
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [str(workspace.user_id), str(workspace.tenant_id)])
        cursor.execute("SELECT access_token_encrypted FROM fintrace.broker_connections")
        return cursor.fetchone()[0]


class Browser:
    """Requests that share one session, like a real browser tab."""

    def __init__(self, user_id, tenant_id):
        self.user_id, self.session = user_id, {"active_company_id": str(tenant_id)}

    def request(self, method, path, query=""):
        factory = RequestFactory()
        request = factory.get(path + query) if method == "get" else factory.post(path, data="{}", content_type="application/json")
        SessionMiddleware(lambda req: None).process_request(request)
        request.session.update(self.session)
        request.user = SimpleNamespace(id=str(self.user_id), is_authenticated=True, is_active=True, is_superuser=False, is_staff=False)
        match = resolve(path)
        response = match.func(request, **match.kwargs)
        self.session = dict(request.session.items())
        return response

    def json(self, method, path, query=""):
        response = self.request(method, path, query)
        return response.status_code, json.loads(response.content)

    def connect(self, request_token="good-request-token"):
        status, body = self.json("post", f"{BASE}/connect/")
        assert status == 200, body
        login = urlparse(body["login_url"])
        params = parse_qs(login.query)
        assert login.netloc == "kite.zerodha.com" and params["api_key"] == [API_KEY]
        state = parse_qs(params["redirect_params"][0])["state"][0]
        response = self.request("get", f"{BASE}/callback/", f"?status=success&action=login&request_token={request_token}&state={state}")
        assert response.status_code == 302
        return parse_qs(urlparse(response["Location"]).query)


def test_connect_sync_and_metrics(fresh, kite):
    browser = Browser(fresh.user_id, fresh.tenant_id)
    status, before = browser.json("get", f"{BASE}/portfolio/")
    assert status == 200 and before["connection"] is None and before["configured"] is True
    ledger_before = fresh.summary()["totals"]

    assert browser.connect() == {"broker": ["zerodha"], "result": ["connected"]}
    status, portfolio = browser.json("get", f"{BASE}/portfolio/")
    assert status == 200
    assert portfolio["connection"]["status"] == "CONNECTED" and portfolio["connection"]["broker_user_name"] == "Asha Rao"
    assert ACCESS_TOKEN not in json.dumps(portfolio) and "access_token" not in json.dumps(portfolio)

    # INFY: 12 units (settled + T1). 12 x 1400.1 = 16801.20 invested, 12 x 1520.35 = 18244.20 now.
    rows = {row["symbol"]: row for row in portfolio["holdings"]}
    assert set(rows) == {"INFY", "TATAMOTORS", "INF879O01027"}  # the zero-quantity holding is dropped
    infy = rows["INFY"]
    assert (Decimal(infy["quantity"]), Decimal(infy["invested_value"]), Decimal(infy["current_value"]), Decimal(infy["pnl"])) == (Decimal("12"), Decimal("16801.20"), Decimal("18244.20"), Decimal("1443.00"))
    assert Decimal(infy["day_change"]) == Decimal("244.20") and infy["pnl_percent"] == 8.59
    fund = rows["INF879O01027"]
    assert fund["asset_class"] == "MUTUAL_FUND" and fund["name"].startswith("Parag Parikh") and fund["folio"] == "123456/78"
    assert (Decimal(fund["invested_value"]), Decimal(fund["current_value"])) == (Decimal("5512.47"), Decimal("7245.89"))
    assert fund["day_change"] is None  # funds have no intraday change

    summary = portfolio["summary"]
    assert Decimal(summary["invested_value"]) == Decimal("16801.20") + Decimal("19000.00") + Decimal("5512.47")
    assert Decimal(summary["current_value"]) == Decimal("18244.20") + Decimal("18010.00") + Decimal("7245.89")
    assert Decimal(summary["pnl"]) == Decimal(summary["current_value"]) - Decimal(summary["invested_value"]) == Decimal("2186.42")
    assert summary["pnl_percent"] == 5.29 and summary["holding_count"] == 3
    assert Decimal(summary["day_change"]) == Decimal("244.20") + Decimal("-190.00")
    by_class = {row["asset_class"]: row for row in portfolio["by_class"]}
    assert Decimal(by_class["EQUITY"]["current_value"]) == Decimal("36254.20") and by_class["MUTUAL_FUND"]["holding_count"] == 1
    assert round(sum(row["allocation_percent"] for row in portfolio["holdings"]), 1) == 100.0
    assert [row["symbol"] for row in portfolio["top_gainers"]] == ["INF879O01027", "INFY"]
    assert [row["symbol"] for row in portfolio["top_losers"]] == ["TATAMOTORS"]
    assert len(portfolio["history"]) == 1 and Decimal(portfolio["history"][0]["current_value"]) == Decimal(summary["current_value"])

    # The token is stored encrypted, and only read-only endpoints were called.
    stored = stored_token(fresh)
    assert stored and ACCESS_TOKEN not in stored
    called = {(method, path) for method, path, _, _ in kite.calls}
    assert called == {("POST", "/session/token"), ("GET", "/portfolio/holdings"), ("GET", "/mf/holdings"), ("GET", "/portfolio/positions"), ("GET", "/mf/sips"), ("GET", "/user/margins")}
    assert all(method == "GET" for method, path in called if path != "/session/token")  # nothing that could place an order

    # Broker figures never touch the ledger.
    assert fresh.summary()["totals"] == ledger_before

    # Syncing again the same day refreshes in place: no duplicate holdings or history points.
    kite.equity = [dict(EQUITY[0], last_price=1600.0)]
    status, again = browser.json("post", f"{BASE}/sync/")
    assert status == 200 and [row["symbol"] for row in again["holdings"] if row["asset_class"] == "EQUITY"] == ["INFY"]
    assert len(again["history"]) == 1 and Decimal(again["summary"]["current_value"]) == Decimal("19200.00") + Decimal("7245.89")


def test_callback_is_bound_to_the_session_that_started_it(fresh, kite):
    browser = Browser(fresh.user_id, fresh.tenant_id)
    # A callback nobody asked for (e.g. a link an attacker sends) connects nothing.
    response = browser.request("get", f"{BASE}/callback/", "?status=success&request_token=good-request-token&state=guessed")
    assert parse_qs(urlparse(response["Location"]).query)["result"] == ["error"]
    assert browser.json("get", f"{BASE}/portfolio/")[1]["connection"] is None
    assert kite.calls == []

    # Declining on Zerodha's page, or a request token Zerodha rejects, also connects nothing.
    browser.json("post", f"{BASE}/connect/")
    state = browser.session[broker_views.STATE_KEY]["state"]
    response = browser.request("get", f"{BASE}/callback/", f"?status=cancelled&state={state}")
    assert parse_qs(urlparse(response["Location"]).query)["result"] == ["cancelled"]
    assert browser.connect(request_token="stolen-or-stale")["result"] == ["error"]
    assert browser.json("get", f"{BASE}/portfolio/")[1]["connection"] is None

    # The state is single-use.
    assert browser.connect()["result"] == ["connected"]
    response = browser.request("get", f"{BASE}/callback/", f"?status=success&request_token=good-request-token&state={state}")
    assert parse_qs(urlparse(response["Location"]).query)["result"] == ["error"]


def test_expired_session_and_outage_keep_the_last_figures(fresh, kite):
    browser = Browser(fresh.user_id, fresh.tenant_id)
    browser.connect()
    value = browser.json("get", f"{BASE}/portfolio/")[1]["summary"]["current_value"]

    kite.mode = "down"
    status, body = browser.json("post", f"{BASE}/sync/")
    assert status == 502 and body["error"]["code"] == "BROKER_UNAVAILABLE"
    after_outage = browser.json("get", f"{BASE}/portfolio/")[1]
    assert after_outage["summary"]["current_value"] == value and after_outage["connection"]["status"] == "CONNECTED"
    assert after_outage["connection"]["last_error"]

    kite.mode = "expired"
    status, body = browser.json("post", f"{BASE}/sync/")
    assert status == 409 and body["error"]["code"] == "BROKER_SESSION_EXPIRED"
    expired = browser.json("get", f"{BASE}/portfolio/")[1]
    assert expired["connection"]["status"] == "EXPIRED" and expired["summary"]["current_value"] == value
    assert stored_token(fresh) is None  # a dead token is not kept

    kite.mode = "ok"
    assert browser.connect()["result"] == ["connected"]
    assert browser.json("get", f"{BASE}/portfolio/")[1]["connection"]["status"] == "CONNECTED"

    status, body = browser.json("post", f"{BASE}/disconnect/")
    assert status == 200 and body["connection"]["status"] == "DISCONNECTED"
    assert ("DELETE", "/session/token") in {(method, path) for method, path, _, _ in kite.calls}
    assert browser.json("post", f"{BASE}/sync/")[1]["error"]["code"] == "BROKER_NOT_CONNECTED"


def test_broker_data_is_per_workspace_and_respects_roles(fresh, kite, context):
    owner = Browser(fresh.user_id, fresh.tenant_id)
    owner.connect()
    _, added = fresh.post("/api/v1/memberships/", {"email": f"viewer_{uuid4().hex[:8]}@example.test", "role": "VIEWER", "password": "a-decent-temporary-pass"})

    viewer = Browser(added["user_id"], fresh.tenant_id)
    status, seen = viewer.json("get", f"{BASE}/portfolio/")
    assert status == 200 and seen["summary"]["holding_count"] == 3
    for path in ("connect", "sync", "disconnect"):
        assert viewer.json("post", f"{BASE}/{path}/")[0] == 403

    other = Browser(context["user_a_id"], context["tenant_a_id"])
    assert other.json("get", f"{BASE}/portfolio/")[1]["connection"] is None
    outsider = Browser(context["user_a_id"], fresh.tenant_id)
    assert outsider.json("get", f"{BASE}/portfolio/")[0] == 403


def test_not_configured_is_reported_plainly(fresh, settings):
    settings.KITE_API_KEY = settings.KITE_API_SECRET = ""
    browser = Browser(fresh.user_id, fresh.tenant_id)
    status, body = browser.json("get", f"{BASE}/portfolio/")
    assert status == 200 and body["configured"] is False and body["connection"] is None
    status, body = browser.json("post", f"{BASE}/connect/")
    assert status == 503 and body["error"]["code"] == "BROKER_NOT_CONFIGURED"


def backdate_snapshots(workspace, admin_connection, days):
    """Pretend today's sync happened ``days`` ago, so a later sync has something to compare with."""
    with admin_connection.cursor() as cursor:
        cursor.execute("SELECT fintrace.set_context(%s::uuid, %s::uuid)", [str(workspace.user_id), str(workspace.tenant_id)])
        for table in ("broker_portfolio_snapshots", "broker_holding_snapshots"):
            cursor.execute(f"UPDATE fintrace.{table} SET snapshot_date = snapshot_date - %s WHERE tenant_id = %s::uuid", [days, str(workspace.tenant_id)])
    admin_connection.commit()


def test_analysis_concentration_periods_sips_and_cash(fresh, kite, admin_connection):
    browser = Browser(fresh.user_id, fresh.tenant_id)
    browser.connect()
    status, body = browser.json("get", f"{BASE}/analytics/")
    assert status == 200
    analysis = body["analysis"]
    total = Decimal("18244.20") + Decimal("18010.00") + Decimal("7245.89")

    # Concentration: 41.94%, 41.40% and 16.66% of 43,500.09.
    focus = analysis["concentration"]
    assert focus["largest"]["symbol"] == "INFY" and focus["largest"]["allocation_percent"] == 41.94
    assert focus["top_3_percent"] == 100.0 and focus["holding_count"] == 3 and focus["effective_holdings"] == 2.7
    assert analysis["performance"] == {"winners": 2, "losers": 1, "unchanged": 0, "gains": "3176.42", "losses": "-990.00"}

    # Cash, SIPs (5000 monthly + 500 weekly = 5000 + 26000/12) and one open position (the squared-off one is dropped).
    assert Decimal(analysis["totals"]["cash_available"]) == Decimal("15250.75")
    assert Decimal(analysis["totals"]["total_with_cash"]) == total + Decimal("15250.75")
    sips = analysis["sips"]
    assert sips["active_count"] == 2 and Decimal(sips["yearly_commitment"]) == Decimal("86000.00") and Decimal(sips["monthly_commitment"]) == Decimal("7166.67")
    assert [row["status"] for row in sips["rows"]] == ["ACTIVE", "ACTIVE", "PAUSED"] and sips["rows"][0]["next_instalment"] == "2099-01-02"
    assert [row["symbol"] for row in analysis["positions"]] == ["NIFTY26OCTFUT"] and Decimal(analysis["totals"]["open_positions_pnl"]) == Decimal("2975.00")

    # On the first day there is nothing to compare with yet.
    assert all(period["available"] is False for period in analysis["periods"] if period["code"] != "ALL")
    assert analysis["holding_changes"]["rows"] == []

    # Ten days later: INFY has risen, and 5 more TATAMOTORS were bought at 900.
    backdate_snapshots(fresh, admin_connection, 10)
    kite.equity = [dict(EQUITY[0], last_price=1600.0), dict(EQUITY[1], quantity=25, average_price=940.0, last_price=900.5)]
    assert browser.json("post", f"{BASE}/sync/")[0] == 200
    analysis = browser.json("get", f"{BASE}/analytics/")[1]["analysis"]
    week = next(p for p in analysis["periods"] if p["code"] == "1W")
    assert week["available"] is True
    # Value went 43,500.09 -> 48,958.39 (+5,458.30); 4,500 of that is new money (25 x 940 - 20 x 950).
    assert Decimal(week["value_change"]) == Decimal("5458.30") and Decimal(week["net_invested"]) == Decimal("4500.00")
    assert Decimal(week["market_movement"]) == Decimal("958.30") and week["market_movement_percent"] == 2.2
    # The only earlier snapshot is ten days old: close enough to stand for "a week ago", not for "yesterday".
    assert next(p for p in analysis["periods"] if p["code"] == "1D")["available"] is False
    changes = {row["symbol"]: row for row in analysis["holding_changes"]["rows"]}
    assert Decimal(changes["INFY"]["market_movement"]) == Decimal("955.80")   # 12 x (1600 - 1520.35)
    assert Decimal(changes["TATAMOTORS"]["market_movement"]) == Decimal("2.50")  # value +4,502.50 less 4,500 added
    assert Decimal(changes["INF879O01027"]["market_movement"]) == 0
    assert len(body["history"]) == 1 and len(browser.json("get", f"{BASE}/portfolio/")[1]["history"]) == 2

    texts = " ".join(note["text"] for note in analysis["insights"])
    assert "2 active SIPs invest about ₹7,166.67 a month" in texts and "is sitting uninvested" in texts and "market movement has gained ₹958.30" in texts

    # The main dashboard carries the headline and provides combined net worth alongside ledger net worth.
    summary = fresh.summary()
    assert Decimal(summary["broker"]["current_value"]) == Decimal("48958.39") and summary["broker"]["status"] == "CONNECTED"
    assert Decimal(summary["totals"]["net_worth"]) == 0
    assert Decimal(summary["broker"]["combined_net_worth"]) == Decimal("48958.39")
    assert Decimal(summary["broker"]["combined_assets"]) == Decimal("48958.39")


def test_sync_still_succeeds_when_optional_data_is_refused(fresh, kite):
    kite.unavailable = {"/mf/sips", "/user/margins"}
    browser = Browser(fresh.user_id, fresh.tenant_id)
    assert browser.connect()["result"] == ["connected"]
    body = browser.json("get", f"{BASE}/analytics/")[1]
    assert body["summary"]["holding_count"] == 3 and body["connection"]["status"] == "CONNECTED"
    assert "SIPs" in body["connection"]["last_error"] and "available funds" in body["connection"]["last_error"]
    assert body["analysis"]["totals"]["cash_available"] is None and body["analysis"]["totals"]["total_with_cash"] is None
    assert body["analysis"]["sips"]["rows"] == [] and len(body["analysis"]["positions"]) == 1
