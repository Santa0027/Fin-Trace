import json
import logging
from decimal import InvalidOperation

from django.db import DatabaseError
from django.http import JsonResponse

from FinTrace.apps.core.domain.exceptions import ApiError

logger = logging.getLogger(__name__)

# SQLSTATE -> (HTTP status, error code, fallback message)
PG_ERROR_CODES = {
    "22003": (400, "INVALID_AMOUNT", "The amount has more decimal places than its currency allows."),
    "22P02": (400, "INVALID_REQUEST", "One of the supplied identifiers or values is malformed."),
    "23502": (400, "VALIDATION_ERROR", "A required value is missing."),
    "23503": (400, "REFERENCE_VIOLATION", "Referenced resource does not exist or is not visible."),
    "23505": (409, "CONFLICT", "Resource already exists."),
    "23514": (400, "CONSTRAINT_VIOLATION", "Request violates a financial database rule."),
    "25006": (409, "IMMUTABLE_RECORD", "Posted financial records cannot be changed. Use a reversal instead."),
    "40001": (409, "RETRY_LATER", "The operation conflicted with another change. Please retry."),
    "40P01": (409, "RETRY_LATER", "The operation conflicted with another change. Please retry."),
    "42501": (403, "PERMISSION_DENIED", "Permission denied for this tenant."),
}

# Named constraints worth a specific, human message. Anything else that names a
# constraint falls back to the generic text so schema details are not leaked.
CONSTRAINT_MESSAGES = {
    "categories_tenant_name_type_uk": "A category with this name already exists.",
    "accounts_tenant_account_number_uk": "Another active account already uses this account number.",
    "tags_tenant_name_uk": "A tag with this name already exists.",
    "ledger_transactions_one_reversal_uk": "This transaction has already been reversed.",
    "ledger_entries_amount_ck": "Amount must be greater than zero.",
    "debts_due_date_ck": "The due date cannot be before the start date.",
    "recurring_transactions_next_run_ck": "The next run date cannot be before the start date.",
    "recurring_transactions_dates_ck": "The end date cannot be before the start date.",
    "investment_instruments_tenant_symbol_uk": "An instrument with this symbol already exists.",
}


def error_response(status: int, code: str, message: str, fields: dict | None = None) -> JsonResponse:
    return JsonResponse({"error": {"code": code, "message": message, "fields": fields or {}}}, status=status)


def _pg_details(exc: DatabaseError) -> tuple[str | None, str | None, str | None]:
    """Return (sqlstate, constraint name, primary message) from a psycopg 3 error."""
    cause = getattr(exc, "__cause__", None) or exc
    sqlstate = getattr(cause, "sqlstate", None)
    diag = getattr(cause, "diag", None)
    return sqlstate, getattr(diag, "constraint_name", None), getattr(diag, "message_primary", None)


def database_error_response(exc: DatabaseError) -> JsonResponse:
    sqlstate, constraint, primary = _pg_details(exc)
    known = PG_ERROR_CODES.get(sqlstate or "")
    if known is None:
        logger.exception("Database operation failed", exc_info=exc)
        return error_response(500, "DATABASE_ERROR", "Database operation failed.")
    status, code, message = known
    if constraint:
        message = CONSTRAINT_MESSAGES.get(constraint, message)
    elif primary and sqlstate in {"23503", "23514", "25006", "22003"}:
        # No constraint name means the database routine raised this itself; those
        # messages are written for people ("Only a COMPLETED transaction may be reversed").
        message = primary
    elif primary and sqlstate == "42501" and "row-level security" not in primary:
        message = primary
    logger.warning("Database rejected request (%s): %s", sqlstate, primary)
    return error_response(status, code, message)


def safe_view(fn):
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ApiError as exc:
            return error_response(exc.status, exc.code, exc.message, exc.fields)
        except DatabaseError as exc:
            return database_error_response(exc)
        except json.JSONDecodeError:
            return error_response(400, "INVALID_JSON", "Request body is not valid JSON.")
        except KeyError as exc:
            field = str(exc.args[0]) if exc.args else "field"
            return error_response(400, "VALIDATION_ERROR", f"{field} is required.", {field: "This field is required."})
        except InvalidOperation:
            return error_response(400, "INVALID_AMOUNT", "A numeric value in the request is not a valid number.")
        except ValueError as exc:
            return error_response(400, "INVALID_REQUEST", str(exc) or "The request is invalid.")
        except Exception:  # noqa: BLE001 - last line of defence: never leak a stack trace
            logger.exception("Unhandled error in API view")
            return error_response(500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.")
    return wrapper
