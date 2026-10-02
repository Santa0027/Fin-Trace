from FinTrace.apps.core.domain.entities import Currency
from FinTrace.apps.core.infrastructure.models import CurrencyModel


class CurrencyMapper:
    @staticmethod
    def to_entity(currency: CurrencyModel) -> Currency:
        return Currency(
            id=currency.id,
            code=currency.code,
            name=currency.name,
            symbol=currency.symbol,
            decimal_places=currency.decimal_places,
            is_active=currency.is_active,
        )
