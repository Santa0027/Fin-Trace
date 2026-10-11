from uuid import UUID

from django.core.management.base import BaseCommand, CommandError

from FinTrace.apps.core.application.dto import TenantContextDTO
from FinTrace.apps.core.application.flows import FinancialFlows
from FinTrace.apps.core.application.parsing import local_today
from FinTrace.apps.core.application.services import TenantAwareService
from FinTrace.apps.core.domain.exceptions import ApiError
from FinTrace.apps.core.infrastructure.read_models import FinancialReadRepository


class Command(BaseCommand):
    help = (
        "Post every recurring item that is due in one workspace, acting as the given member. "
        "Run it on a schedule (cron) to automate recurring income, bills and transfers. "
        "Each occurrence is posted in its own transaction and can never be posted twice."
    )

    def add_arguments(self, parser):
        parser.add_argument("--tenant-id", required=True)
        parser.add_argument("--user-id", required=True, help="an active member allowed to post transactions")
        parser.add_argument("--batch-size", type=int, default=50)

    def handle(self, *args, **options):
        batch_size = options["batch_size"]
        if batch_size <= 0 or batch_size > 500:
            raise CommandError("--batch-size must be between 1 and 500")
        context = TenantContextDTO(user_id=UUID(options["user_id"]), tenant_id=UUID(options["tenant_id"]))
        service = TenantAwareService()
        posted = failed = 0
        attempted: set[UUID] = set()
        # An item that is several periods behind comes back as due after each run.
        for _ in range(batch_size):
            with service._tx(context):
                repo = FinancialReadRepository()
                due = [row for row in repo.due_recurring_ids(local_today(repo.timezone), batch_size) if row not in attempted]
            if not due:
                break
            recurring_id = due[0]
            try:
                with service._tx(context):
                    FinancialFlows().run_recurring(context, recurring_id, {"action": "post"})
                posted += 1
            except ApiError as exc:
                attempted.add(recurring_id)
                failed += 1
                self.stderr.write(f"{recurring_id}: {exc.message}")
        style = self.style.SUCCESS if not failed else self.style.WARNING
        self.stdout.write(style(f"Recurring: {posted} posted, {failed} could not be posted."))
        if failed:
            raise CommandError(f"{failed} recurring item(s) need attention.")
