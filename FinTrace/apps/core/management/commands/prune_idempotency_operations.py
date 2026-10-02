from django.core.management.base import BaseCommand, CommandError

from FinTrace.apps.core.application.services import IdempotencyService
from FinTrace.apps.core.infrastructure.repositories import IdempotencyRepository


class Command(BaseCommand):
    help = "Expire old idempotency operations using the PostgreSQL maintenance procedure."

    def add_arguments(self, parser):
        parser.add_argument("--batch-size", type=int, default=5000)

    def handle(self, *args, **options):
        batch_size = options["batch_size"]
        if batch_size <= 0 or batch_size > 50000:
            raise CommandError("--batch-size must be between 1 and 50000")
        IdempotencyService(IdempotencyRepository()).prune_expired(batch_size)
        self.stdout.write(self.style.SUCCESS(f"Pruned expired idempotency operations with batch size {batch_size}."))
