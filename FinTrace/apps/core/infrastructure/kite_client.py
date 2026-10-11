"""Minimal Zerodha Kite Connect v3 client.

Only what FinTrace needs, all read-only: the login handshake, equity holdings
(Kite), mutual fund holdings (Coin) and session invalidation. Numbers are parsed
as Decimal, never float.
"""
import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal

LOGIN_URL = "https://kite.zerodha.com/connect/login"
API_ROOT = "https://api.kite.trade"
TIMEOUT_SECONDS = 15


class KiteError(Exception):
    """The broker could not be reached or refused the request."""


class KiteSessionExpired(KiteError):
    """The access token is no longer valid; the user has to log in to Zerodha again."""


def _http(method: str, url: str, headers: dict, data: bytes | None) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed https host
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise KiteError(f"Zerodha could not be reached ({error}).") from None


class KiteClient:
    def __init__(self, api_key: str, api_secret: str, transport=_http) -> None:
        self.api_key = api_key
        self.api_secret = api_secret
        self.transport = transport

    def login_url(self, state: str) -> str:
        query = urllib.parse.urlencode({"v": "3", "api_key": self.api_key, "redirect_params": urllib.parse.urlencode({"state": state})})
        return f"{LOGIN_URL}?{query}"

    def _call(self, method: str, path: str, *, access_token: str | None = None, form: dict | None = None):
        headers = {"X-Kite-Version": "3", "Accept": "application/json"}
        if access_token:
            headers["Authorization"] = f"token {self.api_key}:{access_token}"
        data = None
        if form is not None:
            data = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        status, raw = self.transport(method, f"{API_ROOT}{path}", headers, data)
        try:
            body = json.loads(raw.decode("utf-8") or "{}", parse_float=Decimal)
        except (ValueError, UnicodeDecodeError):
            raise KiteError(f"Zerodha returned an unreadable response (HTTP {status}).") from None
        if status == 403 or body.get("error_type") == "TokenException":
            raise KiteSessionExpired(body.get("message") or "The Zerodha session has expired.")
        if status >= 400 or body.get("status") != "success":
            raise KiteError(body.get("message") or f"Zerodha refused the request (HTTP {status}).")
        return body.get("data")

    def create_session(self, request_token: str) -> dict:
        checksum = hashlib.sha256(f"{self.api_key}{request_token}{self.api_secret}".encode()).hexdigest()
        return self._call("POST", "/session/token", form={"api_key": self.api_key, "request_token": request_token, "checksum": checksum})

    def holdings(self, access_token: str) -> list[dict]:
        """Stocks and ETFs held in the demat account (Kite)."""
        return self._call("GET", "/portfolio/holdings", access_token=access_token) or []

    def mutual_fund_holdings(self, access_token: str) -> list[dict]:
        """Mutual fund units held through Coin."""
        return self._call("GET", "/mf/holdings", access_token=access_token) or []

    def positions(self, access_token: str) -> list[dict]:
        """Open positions carried in the account (net), e.g. intraday or derivatives."""
        data = self._call("GET", "/portfolio/positions", access_token=access_token)
        return (data.get("net") or []) if isinstance(data, dict) else []

    def sips(self, access_token: str) -> list[dict]:
        """Mutual fund SIPs set up on Coin."""
        return self._call("GET", "/mf/sips", access_token=access_token) or []

    def margins(self, access_token: str) -> dict:
        """Funds available in the trading account."""
        data = self._call("GET", "/user/margins", access_token=access_token)
        return data if isinstance(data, dict) else {}

    def invalidate(self, access_token: str) -> None:
        query = urllib.parse.urlencode({"api_key": self.api_key, "access_token": access_token})
        self._call("DELETE", f"/session/token?{query}", access_token=access_token)
