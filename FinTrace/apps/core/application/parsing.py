"""Input parsing shared by the API views and the financial flows.

Date semantics, in one place: a calendar day is a day in the workspace's own
timezone (``tenants.timezone``). Reports group by that local day, and an entry
recorded with just a date is stored at local noon of that day.
"""
import json
from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from decimal import Decimal, InvalidOperation
from uuid import UUID

from FinTrace.apps.core.domain.exceptions import ValidationFailed

MAX_AMOUNT = Decimal("999999999999.9999")


def json_body(request) -> dict:
    raw = request.body.decode("utf-8") if request.body else ""
    data = json.loads(raw or "{}")
    if not isinstance(data, dict):
        raise ValidationFailed({"body": "Request body must be a JSON object."})
    return data


def parse_amount(payload: dict, field: str = "amount", *, required: bool = True, allow_zero: bool = False) -> Decimal:
    value = payload.get(field)
    if value is None or value == "":
        if required:
            raise ValidationFailed({field: "Enter an amount."})
        return Decimal("0")
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValidationFailed({field: "Amount must be a number."})
    try:
        amount = Decimal(str(value).strip().replace(",", ""))
    except InvalidOperation:
        raise ValidationFailed({field: "Amount must be a number."}) from None
    if not amount.is_finite():
        raise ValidationFailed({field: "Amount must be a number."})
    if amount < 0 or (amount == 0 and not allow_zero):
        raise ValidationFailed({field: "Amount must be greater than zero."})
    if amount > MAX_AMOUNT:
        raise ValidationFailed({field: "Amount is too large."})
    return amount


def parse_uuid(payload: dict, field: str, *, required: bool = True, label: str | None = None) -> UUID | None:
    value = payload.get(field)
    if value is None or value == "":
        if required:
            raise ValidationFailed({field: f"Select {label or field.replace('_id', '').replace('_', ' ')}."})
        return None
    try:
        return UUID(str(value))
    except ValueError:
        raise ValidationFailed({field: f"{label or field} is not a valid identifier."}) from None


def parse_date(value, field: str) -> date:
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise ValidationFailed({field: "Enter a valid date (YYYY-MM-DD)."}) from None


def zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def local_today(timezone: str | None = None) -> date:
    return datetime.now(zone(timezone)).date()


def business_datetime(day: date, timezone: str | None = None) -> datetime:
    """Local noon of ``day`` in the workspace timezone."""
    return datetime.combine(day, time(12, 0), tzinfo=zone(timezone))


def parse_occurrence(payload: dict, date_field: str = "occurred_on", timezone: str | None = None) -> tuple[datetime, date]:
    """Return (occurred_at, occurred_on) from a payload carrying either or both."""
    raw_at = payload.get("occurred_at")
    raw_on = payload.get(date_field)
    if raw_at and not raw_on:
        try:
            occurred_at = datetime.fromisoformat(str(raw_at).replace("Z", "+00:00"))
        except ValueError:
            raise ValidationFailed({"occurred_at": "Enter a valid date and time."}) from None
        if occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=UTC)
        return occurred_at, occurred_at.astimezone(zone(timezone)).date()
    occurred_on = parse_date(raw_on, date_field) if raw_on else local_today(timezone)
    return business_datetime(occurred_on, timezone), occurred_on


def parse_period(params, timezone: str | None = None) -> tuple[date, date]:
    """Inclusive [date_from, date_to]; defaults to the current month to date in the workspace timezone."""
    today = local_today(timezone)
    date_to = parse_date(params["date_to"], "date_to") if params.get("date_to") else today
    date_from = parse_date(params["date_from"], "date_from") if params.get("date_from") else date_to.replace(day=1)
    if date_from > date_to:
        raise ValidationFailed({"date_from": "The start date must be on or before the end date."})
    return date_from, date_to


def optional_date(params, field: str) -> date | None:
    return parse_date(params[field], field) if params.get(field) else None


def clean_text(payload: dict, field: str, max_length: int = 255) -> str:
    value = payload.get(field)
    if value is None:
        return ""
    return str(value).strip()[:max_length]
