class DomainError(Exception):
    """Base exception for domain errors."""


class CurrencyNotFoundError(DomainError):
    """Raised when a currency cannot be found."""
