import logging

from django.db import DatabaseError, IntegrityError
from django.http import JsonResponse

logger = logging.getLogger(__name__)

PG_ERROR_CODES = {
    "23503": (400, "REFERENCE_VIOLATION", "Referenced resource does not exist or is not visible."),
    "23505": (409, "CONFLICT", "Resource already exists."),
    "23514": (400, "CONSTRAINT_VIOLATION", "Request violates a financial database rule."),
    "42501": (403, "PERMISSION_DENIED", "Permission denied for this tenant."),
}


def database_error_response(exc: DatabaseError) -> JsonResponse:
    code = getattr(getattr(exc, "__cause__", None), "pgcode", None) or getattr(exc, "pgcode", None)
    status, error_code, message = PG_ERROR_CODES.get(code, (500, "DATABASE_ERROR", "Database operation failed."))
    logger.exception("Database operation failed", exc_info=exc)
    return JsonResponse({"error": {"code": error_code, "message": message}}, status=status)


def safe_view(fn):
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except (IntegrityError, DatabaseError) as exc:
            return database_error_response(exc)
        except ValueError as exc:
            return JsonResponse({"error": {"code": "INVALID_REQUEST", "message": str(exc)}}, status=400)
    return wrapper
