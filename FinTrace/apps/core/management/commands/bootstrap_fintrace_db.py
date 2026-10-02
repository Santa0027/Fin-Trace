from django.core.management.base import BaseCommand, CommandError
from django.db import connection

from FinTrace.apps.core.infrastructure.database.connection import authoritative_schema_path


class Command(BaseCommand):
    help = "Bootstrap a clean PostgreSQL database with the authoritative root schema.sql."

    def add_arguments(self, parser):
        parser.add_argument("--yes-run-on-empty-db", action="store_true", help="Required safety confirmation.")

    def handle(self, *args, **options):
        if not options["yes_run_on_empty_db"]:
            raise CommandError("Refusing to run schema bootstrap without --yes-run-on-empty-db.")

        schema_path = authoritative_schema_path()
        sql = schema_path.read_text()
        with connection.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'fintrace'")
            table_count = cursor.fetchone()[0]
            if table_count:
                raise CommandError("Refusing to bootstrap: schema 'fintrace' already contains tables.")
            cursor.execute(sql)
        self.stdout.write(self.style.SUCCESS(f"Bootstrapped database from {schema_path}"))
