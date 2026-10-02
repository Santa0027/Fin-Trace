import re

from django.core.management.base import BaseCommand, CommandError
from django.db import OperationalError, connection

from FinTrace.apps.core.infrastructure.database.connection import authoritative_schema_path


CREATE_PATTERNS = {
    "table": re.compile(r"CREATE TABLE(?: IF NOT EXISTS)? fintrace\.([a-zA-Z0-9_]+)", re.IGNORECASE),
    "view": re.compile(r"CREATE(?: OR REPLACE)? VIEW fintrace\.([a-zA-Z0-9_]+)", re.IGNORECASE),
    "routine": re.compile(r"CREATE(?: OR REPLACE)? (?:FUNCTION|PROCEDURE) fintrace\.([a-zA-Z0-9_]+)", re.IGNORECASE),
}


class Command(BaseCommand):
    help = "Validate runtime PostgreSQL role safety and authoritative schema object presence."

    def add_arguments(self, parser):
        parser.add_argument("--strict", action="store_true", help="Fail when any schema object is missing.")

    def handle(self, *args, **options):
        expected = self._expected_objects()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT current_user, session_user")
                current_user, session_user = cursor.fetchone()
                cursor.execute(
                    """
                    SELECT rolsuper, rolbypassrls, rolinherit
                      FROM pg_roles
                     WHERE rolname = current_user
                    """
                )
                role_flags = cursor.fetchone()
                if role_flags is None:
                    raise CommandError("Could not inspect current runtime role.")
                cursor.execute(
                    """
                    SELECT r.rolname
                      FROM pg_auth_members m
                      JOIN pg_roles r ON r.oid = m.roleid
                      JOIN pg_roles u ON u.oid = m.member
                     WHERE u.rolname = current_user
                     ORDER BY r.rolname
                    """
                )
                memberships = [row[0] for row in cursor.fetchall()]
                actual = self._actual_objects(cursor)
        except OperationalError as exc:
            raise CommandError(f"Could not connect to runtime database with current DATABASE_* settings: {exc}") from exc

        missing = {
            kind: sorted(expected[kind] - actual[kind])
            for kind in expected
        }
        unsafe = []
        if role_flags[0]:
            unsafe.append("SUPERUSER")
        if role_flags[1]:
            unsafe.append("BYPASSRLS")
        if current_user == "fintrace_owner" or "fintrace_owner" in memberships:
            unsafe.append("FINTRACE_OWNER")

        self.stdout.write(f"current_user={current_user}")
        self.stdout.write(f"session_user={session_user}")
        self.stdout.write(f"rolsuper={role_flags[0]} rolbypassrls={role_flags[1]} rolinherit={role_flags[2]}")
        self.stdout.write(f"memberships={','.join(memberships) if memberships else '(none)'}")
        for kind in ["table", "view", "routine"]:
            self.stdout.write(f"{kind}s: expected={len(expected[kind])} actual={len(actual[kind])} missing={len(missing[kind])}")
            if missing[kind]:
                self.stdout.write(f"missing_{kind}s={','.join(missing[kind])}")

        if unsafe:
            raise CommandError(f"Unsafe runtime role flags/memberships: {', '.join(unsafe)}")
        if options["strict"] and any(missing.values()):
            raise CommandError("Runtime database is missing authoritative schema objects.")
        self.stdout.write(self.style.SUCCESS("Runtime database validation completed."))

    def _expected_objects(self) -> dict[str, set[str]]:
        sql = authoritative_schema_path().read_text()
        return {kind: set(pattern.findall(sql)) for kind, pattern in CREATE_PATTERNS.items()}

    def _actual_objects(self, cursor) -> dict[str, set[str]]:
        cursor.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'fintrace'")
        tables = {row[0] for row in cursor.fetchall()}
        cursor.execute("SELECT viewname FROM pg_views WHERE schemaname = 'fintrace'")
        views = {row[0] for row in cursor.fetchall()}
        cursor.execute(
            """
            SELECT routine_name
              FROM information_schema.routines
             WHERE specific_schema = 'fintrace'
            """
        )
        routines = {row[0] for row in cursor.fetchall()}
        return {"table": tables, "view": views, "routine": routines}
