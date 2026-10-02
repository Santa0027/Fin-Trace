from collections.abc import Iterable, Mapping, Sequence
from decimal import Decimal
from uuid import UUID

from django.db import connection


class DatabaseExecutor:
    def fetch_all(self, sql: str, params: Sequence[object] | None = None) -> list[dict]:
        with connection.cursor() as cursor:
            cursor.execute(sql, list(params or []))
            columns = [column[0] for column in cursor.description]
            return [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]

    def fetch_one(self, sql: str, params: Sequence[object] | None = None) -> dict | None:
        rows = self.fetch_all(sql, params)
        return rows[0] if rows else None

    def execute_returning_id(self, sql: str, params: Sequence[object]) -> UUID:
        with connection.cursor() as cursor:
            cursor.execute(sql, list(params))
            return cursor.fetchone()[0]

    def execute(self, sql: str, params: Sequence[object] | None = None) -> None:
        with connection.cursor() as cursor:
            cursor.execute(sql, list(params or []))


def serialize_value(value):
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, list):
        return [serialize_value(item) for item in value]
    if isinstance(value, dict):
        return serialize_row(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def serialize_row(row: Mapping[str, object]) -> dict:
    return {key: serialize_value(value) for key, value in row.items()}


def serialize_rows(rows: Iterable[Mapping[str, object]]) -> list[dict]:
    return [serialize_row(row) for row in rows]
