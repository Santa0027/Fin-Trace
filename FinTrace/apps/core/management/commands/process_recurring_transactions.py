from uuid import UUID

from django.core.management.base import BaseCommand, CommandError

from FinTrace.apps.core.application.dto import TenantContextDTO
from FinTrace.apps.core.application.services import RecurringService
from FinTrace.apps.core.infrastructure.repositories import PostgreSQLLedgerRepository, RecurringRepository


class Command(BaseCommand):
    help = "Process due recurring transaction occurrences with PostgreSQL row locking."

    def add_arguments(self, parser):
        parser.add_argument("--tenant-id", required=True)
        parser.add_argument("--user-id", required=True)
        parser.add_argument("--batch-size", type=int, default=50)

    def handle(self, *args, **options):
        batch_size = options["batch_size"]
        if batch_size <= 0 or batch_size > 500:
            raise CommandError("--batch-size must be between 1 and 500")
        context = TenantContextDTO(user_id=UUID(options["user_id"]), tenant_id=UUID(options["tenant_id"]))
        rows = RecurringService(RecurringRepository(), PostgreSQLLedgerRepository()).process_due_occurrences(context, batch_size)
        completed = sum(1 for row in rows if row["status"] == "COMPLETED")
        failed = sum(1 for row in rows if row["status"] == "FAILED")
        self.stdout.write(self.style.SUCCESS(f"Processed {len(rows)} recurring occurrence(s): {completed} completed, {failed} failed."))
