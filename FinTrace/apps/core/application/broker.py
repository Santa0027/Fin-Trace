"""Zerodha (Kite + Coin) connection: read-only portfolio snapshots and their metrics.

Nothing here touches the ledger. The broker's view (quantities, market prices,
profit and loss) is stored beside it and shown as the broker's figures.
"""
import base64
import hashlib
import secrets
from datetime import date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings

from FinTrace.apps.core.application.dto import TenantContextDTO
from FinTrace.apps.core.application.parsing import local_today
from FinTrace.apps.core.application.services import TenantAwareService
from FinTrace.apps.core.domain.exceptions import ApiError, Conflict, NotFound, PermissionDenied
from FinTrace.apps.core.infrastructure.broker_repository import BrokerRepository
from FinTrace.apps.core.infrastructure.flow_repository import FlowRepository
from FinTrace.apps.core.infrastructure.kite_client import KiteClient, KiteError, KiteSessionExpired
from FinTrace.apps.core.infrastructure.read_models import FinancialReadRepository

PROVIDER = "ZERODHA"
CURRENCY = "INR"
INDIA = ZoneInfo("Asia/Kolkata")
CENT = Decimal("0.01")
ZERO = Decimal("0")


def is_configured() -> bool:
    return bool(settings.KITE_API_KEY and settings.KITE_API_SECRET)


def _cipher() -> Fernet:
    key = settings.FINTRACE_TOKEN_ENCRYPTION_KEY
    if not key:
        key = base64.urlsafe_b64encode(hashlib.sha256(f"fintrace.broker-token:{settings.SECRET_KEY}".encode()).digest()).decode()
    return Fernet(key)


def _money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(CENT, rounding=ROUND_HALF_UP)


def _percent(part: Decimal, whole: Decimal) -> float | None:
    return float((part / whole * 100).quantize(CENT, rounding=ROUND_HALF_UP)) if whole else None


def token_expiry(now: datetime | None = None) -> datetime:
    """Zerodha invalidates every access token at 6 AM India time the next morning."""
    now = (now or datetime.now(INDIA)).astimezone(INDIA)
    cutoff = datetime.combine(now.date(), time(6, 0), tzinfo=INDIA)
    return cutoff if now < cutoff else cutoff + timedelta(days=1)


def normalise_holdings(equity: list[dict], funds: list[dict]) -> list[dict]:
    """Turn Kite's two holdings payloads into one list of rows with consistent arithmetic."""
    rows = []
    for item in equity:
        quantity = Decimal(str(item.get("quantity") or 0)) + Decimal(str(item.get("t1_quantity") or 0))
        if quantity <= 0:
            continue
        average, last = Decimal(str(item.get("average_price") or 0)), Decimal(str(item.get("last_price") or 0))
        close = Decimal(str(item["close_price"])) if item.get("close_price") else None
        invested, current = _money(quantity * average), _money(quantity * last)
        rows.append({
            "asset_class": "EQUITY", "symbol": str(item.get("tradingsymbol") or "")[:100], "name": "", "exchange": str(item.get("exchange") or "")[:20],
            "isin": str(item.get("isin") or "")[:20], "folio": "", "quantity": quantity, "average_price": average, "last_price": last, "close_price": close,
            "invested_value": invested, "current_value": current, "pnl": current - invested,
            "day_change": _money(quantity * (last - close)) if close else None,
        })
    for item in funds:
        quantity = Decimal(str(item.get("quantity") or 0))
        if quantity <= 0:
            continue
        average, last = Decimal(str(item.get("average_price") or 0)), Decimal(str(item.get("last_price") or 0))
        invested, current = _money(quantity * average), _money(quantity * last)
        rows.append({
            "asset_class": "MUTUAL_FUND", "symbol": str(item.get("tradingsymbol") or "")[:100], "name": str(item.get("fund") or "")[:255], "exchange": "",
            "isin": str(item.get("tradingsymbol") or "")[:20], "folio": str(item.get("folio") or "")[:50], "quantity": quantity, "average_price": average,
            "last_price": last, "close_price": None, "invested_value": invested, "current_value": current, "pnl": current - invested, "day_change": None,
        })
    return rows


def normalise_positions(items: list[dict]) -> list[dict]:
    rows = []
    for item in items:
        quantity = Decimal(str(item.get("quantity") or 0))
        if quantity == 0:
            continue  # squared off; nothing is open
        rows.append({
            "symbol": str(item.get("tradingsymbol") or "")[:100], "exchange": str(item.get("exchange") or "")[:20], "product": str(item.get("product") or "")[:20],
            "quantity": quantity, "average_price": Decimal(str(item.get("average_price") or 0)), "last_price": Decimal(str(item.get("last_price") or 0)),
            "pnl": _money(item.get("pnl")),
        })
    return rows


def _as_date(value) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def normalise_sips(items: list[dict]) -> list[dict]:
    rows = []
    for item in items:
        pending = item.get("pending_instalments")
        rows.append({
            "sip_id": str(item.get("sip_id") or "")[:50], "fund": str(item.get("fund") or "")[:255], "symbol": str(item.get("tradingsymbol") or "")[:100],
            "status": str(item.get("status") or "").upper()[:20], "frequency": str(item.get("frequency") or "").lower()[:20],
            "instalment_amount": _money(item.get("instalment_amount")), "instalment_day": int(item["instalment_day"]) if item.get("instalment_day") else None,
            "next_instalment": _as_date(item.get("next_instalment")), "completed_instalments": int(item.get("completed_instalments") or 0),
            "pending_instalments": int(pending) if pending is not None else -1,
        })
    return rows


def available_cash(margins: dict) -> Decimal | None:
    equity = (margins or {}).get("equity") or {}
    available = equity.get("available") or {}
    value = available.get("live_balance", available.get("cash", equity.get("net")))
    return _money(value) if value is not None else None


# How many instalments a year each SIP frequency makes.
SIP_PER_YEAR = {"weekly": 52, "fortnightly": 26, "monthly": 12, "quarterly": 4}
PERIODS = [("1D", "Since yesterday", 1), ("1W", "1 week", 7), ("1M", "1 month", 30), ("3M", "3 months", 90), ("6M", "6 months", 182), ("1Y", "1 year", 365)]
# Snapshots exist only for days someone synced. A period is shown only when there is
# one reasonably close to its start; otherwise "since yesterday" could mean last week.
PERIOD_SLACK_DAYS = {"1D": 3, "1W": 5, "1M": 10, "3M": 20, "6M": 30, "1Y": 45}


def _inr(value) -> str:
    return f"₹{abs(value):,.2f}"


class BrokerService(TenantAwareService):
    def __init__(self, client: KiteClient | None = None) -> None:
        self.repository = BrokerRepository()
        self._client = client

    @property
    def client(self) -> KiteClient:
        if self._client is None:
            if not is_configured():
                raise ApiError("The Zerodha connection is not set up on this server yet.", code="BROKER_NOT_CONFIGURED", status=503)
            self._client = KiteClient(settings.KITE_API_KEY, settings.KITE_API_SECRET)
        return self._client

    def _require(self, permission: str) -> None:
        if not FinancialReadRepository().has_permissions([permission])[permission]:
            raise PermissionDenied(f"You need the {permission} permission to do this.")

    # -- connecting --------------------------------------------------------
    def begin_login(self, context: TenantContextDTO) -> tuple[str, str]:
        """Return (login URL, state). The state must come back unchanged on the callback."""
        with self._tx(context):
            self._require("investments.update")
        state = secrets.token_urlsafe(24)
        return self.client.login_url(state), state

    def complete_login(self, context: TenantContextDTO, request_token: str) -> dict:
        try:
            session = self.client.create_session(request_token)
        except KiteError as error:
            raise Conflict(f"Zerodha did not complete the sign-in: {error}", code="BROKER_LOGIN_FAILED") from None
        token = _cipher().encrypt(str(session["access_token"]).encode()).decode()
        with self._tx(context):
            self._require("investments.update")
            self.repository.save_connection(
                context.tenant_id, context.user_id, PROVIDER, "CONNECTED",
                str(session.get("user_id") or "")[:50], str(session.get("user_name") or session.get("user_shortname") or "")[:255], token, token_expiry(),
            )
        return self.sync(context)

    def disconnect(self, context: TenantContextDTO) -> None:
        with self._tx(context):
            self._require("investments.update")
            connection = self.repository.connection(PROVIDER, with_token=True, for_update=True)
            if connection is None:
                raise NotFound("Zerodha is not connected.")
            token = self._token(connection)
            self.repository.set_status(connection["id"], "DISCONNECTED")
        if token and is_configured():
            try:
                self.client.invalidate(token)
            except KiteError:
                pass  # the token is already gone from FinTrace and expires on its own by morning

    # -- syncing -----------------------------------------------------------
    def _token(self, connection: dict) -> str | None:
        encrypted = connection.get("access_token_encrypted")
        if not encrypted:
            return None
        try:
            return _cipher().decrypt(encrypted.encode()).decode()
        except InvalidToken:
            return None

    def sync(self, context: TenantContextDTO) -> dict:
        with self._tx(context):
            self._require("investments.update")
            connection = self.repository.connection(PROVIDER, with_token=True)
        if connection is None or connection["status"] in {"DISCONNECTED", "SAMPLE"}:
            raise Conflict("Connect Zerodha first.", code="BROKER_NOT_CONNECTED")
        token = self._token(connection)
        if not token:
            self._expire(context, connection["id"])
        try:
            rows = normalise_holdings(self.client.holdings(token), self.client.mutual_fund_holdings(token))
        except KiteSessionExpired:
            self._expire(context, connection["id"])
        except KiteError as error:
            with self._tx(context):
                self.repository.set_status(connection["id"], "CONNECTED", str(error))
            raise ApiError(f"Could not refresh from Zerodha: {error} Your last synced figures are unchanged.", code="BROKER_UNAVAILABLE", status=502) from None
        # Extras are worth having but must never block the holdings refresh: an account
        # without Coin, or an API plan without some endpoint, still syncs.
        extras, missing = {}, []
        for name, label, fetch in (
            ("cash", "available funds", lambda: available_cash(self.client.margins(token))),
            ("positions", "open positions", lambda: normalise_positions(self.client.positions(token))),
            ("sips", "SIPs", lambda: normalise_sips(self.client.sips(token))),
        ):
            try:
                extras[name] = fetch()
            except KiteSessionExpired:
                self._expire(context, connection["id"])
            except KiteError:
                extras[name] = None
                missing.append(label)
        with self._tx(context):
            timezone = FlowRepository().timezone()
            self.repository.replace_holdings(context.tenant_id, connection["id"], rows, local_today(timezone))
            note = f"Holdings refreshed, but Zerodha did not return: {', '.join(missing)}." if missing else ""
            self.repository.replace_extras(context.tenant_id, connection["id"], extras["cash"], extras["positions"], extras["sips"], note)
        return self.portfolio(context)

    def _expire(self, context: TenantContextDTO, connection_id) -> "NoReturn":  # noqa: F821
        with self._tx(context):
            self.repository.set_status(connection_id, "EXPIRED")
        raise Conflict(
            "Your Zerodha session has ended (Zerodha signs every app out each morning). Reconnect to refresh.",
            code="BROKER_SESSION_EXPIRED",
        )

    # -- reading -----------------------------------------------------------
    def portfolio(self, context: TenantContextDTO) -> dict:
        with self._tx(context):
            self._require("investments.view")
            connection = self.repository.connection(PROVIDER)
            if connection is None:
                return {"provider": PROVIDER, "configured": is_configured(), "currency": CURRENCY, "connection": None}
            if connection["status"] == "CONNECTED" and connection["token_expires_at"] and connection["token_expires_at"] <= datetime.now(INDIA):
                connection["status"] = "EXPIRED"  # shown as expired; the row is updated on the next sync attempt
            holdings = self.repository.holdings(connection["id"])
            history = self.repository.history(connection["id"])

        invested = sum((row["invested_value"] for row in holdings), ZERO)
        current = sum((row["current_value"] for row in holdings), ZERO)
        priced_today = [row for row in holdings if row["day_change"] is not None]
        day_change = sum((row["day_change"] for row in priced_today), ZERO)
        previous_value = sum((row["current_value"] - row["day_change"] for row in priced_today), ZERO)
        for row in holdings:
            row["pnl_percent"] = _percent(row["pnl"], row["invested_value"])
            row["allocation_percent"] = _percent(row["current_value"], current) or 0.0
            row["day_change_percent"] = _percent(row["day_change"], row["current_value"] - row["day_change"]) if row["day_change"] is not None else None
        classes = []
        for asset_class, label in (("EQUITY", "Stocks and ETFs (Kite)"), ("MUTUAL_FUND", "Mutual funds (Coin)")):
            rows = [row for row in holdings if row["asset_class"] == asset_class]
            class_invested = sum((row["invested_value"] for row in rows), ZERO)
            class_current = sum((row["current_value"] for row in rows), ZERO)
            classes.append({
                "asset_class": asset_class, "label": label, "holding_count": len(rows), "invested_value": class_invested, "current_value": class_current,
                "pnl": class_current - class_invested, "pnl_percent": _percent(class_current - class_invested, class_invested),
                "allocation_percent": _percent(class_current, current) or 0.0,
            })
        movers = sorted((row for row in holdings if row["pnl_percent"] is not None), key=lambda row: row["pnl_percent"], reverse=True)
        brief = lambda row: {"symbol": row["symbol"], "name": row["name"], "pnl": row["pnl"], "pnl_percent": row["pnl_percent"]}  # noqa: E731
        return {
            "provider": PROVIDER,
            "configured": is_configured(),
            "currency": CURRENCY,
            "connection": connection,
            "summary": {
                "holding_count": len(holdings), "invested_value": invested, "current_value": current, "pnl": current - invested,
                "pnl_percent": _percent(current - invested, invested),
                # Mutual fund NAVs have no intraday change, so this covers stocks and ETFs only.
                "day_change": day_change if priced_today else None,
                "day_change_percent": _percent(day_change, previous_value) if priced_today else None,
            },
            "by_class": classes,
            "top_gainers": [brief(row) for row in movers[:3] if row["pnl"] > 0],
            "top_losers": [brief(row) for row in reversed(movers[-3:]) if row["pnl"] < 0],
            "holdings": holdings,
            "history": history,
        }

    # -- analysis ----------------------------------------------------------
    def analytics(self, context: TenantContextDTO) -> dict:
        """Everything the analysis screens need, computed here so every screen agrees."""
        portfolio = self.portfolio(context)
        connection = portfolio["connection"]
        if connection is None or not portfolio.get("holdings"):
            return {**portfolio, "analysis": None}
        holdings, summary = portfolio["holdings"], portfolio["summary"]
        current = summary["current_value"]
        with self._tx(context):
            today = local_today(FlowRepository().timezone())
            positions = self.repository.positions(connection["id"])
            sips = self.repository.sips(connection["id"])
            baselines = {code: self.repository.holding_values_on_or_before(connection["id"], today - timedelta(days=days)) for code, _, days in PERIODS}
            first_day = min((point["snapshot_date"] for point in portfolio["history"]), default=None)
            baselines["ALL"] = self.repository.holding_values_on_or_before(connection["id"], first_day) if first_day else (None, {})

        # Concentration: how much rides on the largest few holdings.
        weights = sorted((row["current_value"] / current for row in holdings), reverse=True) if current else []
        share = lambda count: float((sum(weights[:count], ZERO) * 100).quantize(CENT))  # noqa: E731
        effective = float((1 / sum((w * w for w in weights), ZERO)).quantize(Decimal("0.1"))) if weights else 0.0

        winners = [row for row in holdings if row["pnl"] > 0]
        losers = [row for row in holdings if row["pnl"] < 0]

        # Change over time. "Market movement" strips out money you added or withdrew:
        # it is the change in value minus the change in what you had invested.
        keyed = {(row["asset_class"], row["symbol"], row["folio"]): row for row in holdings}
        periods = []
        for code, label, _days in [*PERIODS, ("ALL", "Since first sync", 0)]:
            day, then = baselines[code]
            stale = code != "ALL" and day is not None and (today - timedelta(days=_days) - day).days > PERIOD_SLACK_DAYS[code]
            if day is None or stale or (code != "ALL" and day == today):
                periods.append({"code": code, "label": label, "available": False})
                continue
            then_value = sum((r["current_value"] for r in then.values()), ZERO)
            then_invested = sum((r["invested_value"] for r in then.values()), ZERO)
            value_change = current - then_value
            added = summary["invested_value"] - then_invested
            market = value_change - added
            periods.append({
                "code": code, "label": label, "available": True, "from_date": day, "value_then": then_value, "value_change": value_change,
                "net_invested": added, "market_movement": market, "market_movement_percent": _percent(market, then_value),
            })

        # Per-holding movement over the longest window we have data for.
        month_ok = any(p["code"] == "1M" and p["available"] for p in periods)
        base_day, base = baselines["1M"] if month_ok else baselines["ALL"]
        holding_changes = []
        if base_day and base_day != today:
            for key, row in keyed.items():
                before = base.get(key)
                market = (row["current_value"] - before["current_value"]) - (row["invested_value"] - before["invested_value"]) if before else None
                holding_changes.append({
                    "symbol": row["symbol"], "name": row["name"], "asset_class": row["asset_class"], "is_new": before is None,
                    "value_then": before["current_value"] if before else None, "value_now": row["current_value"],
                    "market_movement": market, "market_movement_percent": _percent(market, before["current_value"]) if before else None,
                })
            holding_changes.sort(key=lambda item: (item["market_movement"] is None, -(item["market_movement"] or ZERO)))

        active_sips = [sip for sip in sips if sip["status"] == "ACTIVE"]
        yearly = sum((sip["instalment_amount"] * SIP_PER_YEAR.get(sip["frequency"], 12) for sip in active_sips), ZERO)
        cash = connection.get("cash_available")
        open_pnl = sum((row["pnl"] for row in positions), ZERO)

        analysis = {
            "as_of": connection["last_synced_at"],
            "totals": {
                "holdings_value": current, "cash_available": cash, "total_with_cash": current + cash if cash is not None else None,
                "open_positions_pnl": open_pnl if positions else None,
            },
            "concentration": {
                "largest": {"symbol": holdings[0]["symbol"], "name": holdings[0]["name"], "allocation_percent": holdings[0]["allocation_percent"]},
                "top_3_percent": share(3), "top_5_percent": share(5), "effective_holdings": effective, "holding_count": len(holdings),
            },
            "performance": {
                "winners": len(winners), "losers": len(losers), "unchanged": len(holdings) - len(winners) - len(losers),
                "gains": sum((row["pnl"] for row in winners), ZERO), "losses": sum((row["pnl"] for row in losers), ZERO),
            },
            "periods": periods,
            "holding_changes": {"from_date": base_day if holding_changes else None, "rows": holding_changes},
            "sips": {"active_count": len(active_sips), "monthly_commitment": _money(yearly / 12), "yearly_commitment": _money(yearly), "rows": sips},
            "positions": positions,
        }
        analysis["insights"] = self._insights(portfolio, analysis)
        return {**portfolio, "analysis": analysis}

    @staticmethod
    def _insights(portfolio: dict, analysis: dict) -> list[dict]:
        """Plain observations, each one a direct reading of the figures above. No scores, no predictions."""
        notes: list[dict] = []
        summary, focus, performance = portfolio["summary"], analysis["concentration"], analysis["performance"]
        add = lambda tone, text: notes.append({"tone": tone, "text": text})  # noqa: E731
        largest = focus["largest"]
        if largest["allocation_percent"] >= 25:
            add("warn", f"{largest['name'] or largest['symbol']} alone is {largest['allocation_percent']:.1f}% of the portfolio. A fall in it moves everything.")
        if focus["holding_count"] >= 5 and focus["top_3_percent"] >= 60:
            add("warn", f"Your three largest holdings make up {focus['top_3_percent']:.1f}% of the value, so the other {focus['holding_count'] - 3} barely move the total.")
        if focus["holding_count"] >= 4:
            add("info", f"Although you hold {focus['holding_count']} things, the money is spread as if evenly across about {focus['effective_holdings']:g}.")
        for row in portfolio["by_class"]:
            if row["holding_count"] and row["allocation_percent"] >= 80:
                add("info", f"{row['allocation_percent']:.1f}% is in {row['label'].split(' (')[0].lower()}.")
        if performance["losers"]:
            worst = min(portfolio["holdings"], key=lambda row: row["pnl_percent"] if row["pnl_percent"] is not None else 0)
            add("info", f"{performance['losers']} of {focus['holding_count']} holdings are below what you paid, down {_inr(performance['losses'])} in total. "
                        f"The weakest is {worst['name'] or worst['symbol']} at {worst['pnl_percent']:.2f}%.")
        else:
            add("good", "Every holding is at or above what you paid for it.")
        usable = {p["code"]: p for p in analysis["periods"] if p["available"] and p.get("value_then")}
        month = usable.get("1M") or usable.get("ALL")  # a month if we have one, otherwise as far back as we can see
        if month and month["market_movement_percent"] is not None:
            direction = "gained" if month["market_movement"] >= 0 else "lost"
            add("good" if month["market_movement"] >= 0 else "warn",
                f"Since {month['from_date']:%d %b}, market movement has {direction} {_inr(month['market_movement'])} ({abs(month['market_movement_percent']):.2f}%), not counting money you added.")
        sips = analysis["sips"]
        if sips["active_count"]:
            add("info", f"{sips['active_count']} active SIP{'s' if sips['active_count'] != 1 else ''} invest about {_inr(sips['monthly_commitment'])} a month, {_inr(sips['yearly_commitment'])} a year.")
        cash = analysis["totals"]["cash_available"]
        if cash is not None and summary["current_value"] and cash > summary["current_value"] * Decimal("0.10"):
            add("info", f"{_inr(cash)} is sitting uninvested in the trading account, {_percent(cash, summary['current_value']):.1f}% of what is invested.")
        return notes
