from pathlib import Path

from django.conf import settings


def authoritative_schema_path() -> Path:
    schema_path = settings.BASE_DIR / "schema.sql"
    if not schema_path.exists():
        raise FileNotFoundError(f"Authoritative schema file not found: {schema_path}")
    return schema_path
