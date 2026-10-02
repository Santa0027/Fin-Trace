from FinTrace.apps.core.application.dto import CurrencyDTO


def serialize_currency(currency: CurrencyDTO) -> dict[str, str | int]:
    return {
        "id": str(currency.id),
        "code": currency.code,
        "name": currency.name,
        "symbol": currency.symbol,
        "decimal_places": currency.decimal_places,
    }
