from typing import Protocol

from FinTrace.apps.core.application.dto import CurrencyDTO


class CurrencyServiceInterface(Protocol):
    def list_active_currencies(self) -> list[CurrencyDTO]:
        """Return active currencies for callers outside the domain."""

    def get_currency(self, code: str) -> CurrencyDTO | None:
        """Return a currency by code, or None when it does not exist."""
