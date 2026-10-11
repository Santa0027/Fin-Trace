class DomainError(Exception):
    """Base exception for domain errors."""


class CurrencyNotFoundError(DomainError):
    """Raised when a currency cannot be found."""


class ApiError(DomainError):
    """An error with a stable machine code that is safe to show to the caller."""

    status = 400
    code = "INVALID_REQUEST"

    def __init__(self, message: str, *, code: str | None = None, status: int | None = None, fields: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if status is not None:
            self.status = status
        self.fields = fields or {}


class AuthenticationRequired(ApiError):
    status = 401
    code = "UNAUTHENTICATED"


class NoActiveTenant(ApiError):
    status = 409
    code = "NO_ACTIVE_TENANT"


class PermissionDenied(ApiError):
    status = 403
    code = "PERMISSION_DENIED"


class NotFound(ApiError):
    status = 404
    code = "NOT_FOUND"


class Conflict(ApiError):
    status = 409
    code = "CONFLICT"


class ValidationFailed(ApiError):
    status = 400
    code = "VALIDATION_ERROR"

    def __init__(self, fields: dict[str, str], message: str | None = None, *, code: str | None = None) -> None:
        super().__init__(message or next(iter(fields.values()), "The request is invalid."), code=code, fields=fields)
