from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID


@dataclass(frozen=True)
class Currency:
    id: UUID
    code: str
    name: str
    symbol: str
    decimal_places: int
    is_active: bool


@dataclass(frozen=True)
class Money:
    amount: Decimal
    currency_id: UUID

    def __post_init__(self) -> None:
        if not isinstance(self.amount, Decimal):
            raise TypeError("Money.amount must be a Decimal")
