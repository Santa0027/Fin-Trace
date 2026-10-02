from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

from django.test import SimpleTestCase
from unittest.mock import patch

from FinTrace.apps.core.application.dto import CreateLedgerTransactionDTO, LedgerEntryDTO, TenantContextDTO
from FinTrace.apps.core.application.services import LedgerService
from FinTrace.apps.core.domain.entities import Money
from FinTrace.apps.core.infrastructure.database import context as db_context
from FinTrace.apps.core.infrastructure.sql import functions


class MoneyTests(SimpleTestCase):
    def test_money_rejects_float_amount(self):
        with self.assertRaises(TypeError):
            Money(12.30, uuid4())


class LedgerServiceTests(SimpleTestCase):
    def test_create_transaction_sets_tenant_context_and_calls_repository(self):
        context = TenantContextDTO(user_id=uuid4(), tenant_id=uuid4())
        transaction_id = uuid4()
        account_id = uuid4()

        class Repo:
            def __init__(self):
                self.calls = []

            def create_transaction(self, occurred_at, reference="", description=""):
                self.calls.append(("create", occurred_at, reference, description))
                return transaction_id

            def add_entry(self, transaction_id_arg, account_id_arg, debit_amount, credit_amount, exchange_rate=Decimal("1")):
                self.calls.append(("entry", transaction_id_arg, account_id_arg, debit_amount, credit_amount, exchange_rate))
                return uuid4()

        repo = Repo()
        dto = CreateLedgerTransactionDTO(
            occurred_at=datetime(2026, 1, 1, tzinfo=UTC),
            reference="INV-1",
            description="test",
            entries=(LedgerEntryDTO(account_id=account_id, debit_amount=Decimal("10")),),
        )
        with patch.object(db_context, "tenant_transaction") as patched_context:
            patched_context.return_value.__enter__.return_value = None
            patched_context.return_value.__exit__.return_value = None
            result = LedgerService(repo).create_transaction(context, dto)

        self.assertEqual(result, transaction_id)
        patched_context.assert_called_once_with(context.user_id, context.tenant_id, request_id=None, client_ip=None, user_agent=None)
        self.assertEqual(repo.calls[0][0], "create")
        self.assertEqual(repo.calls[1][0], "entry")


class SQLFunctionSignatureTests(SimpleTestCase):
    def test_ledger_repository_uses_schema_functions(self):
        self.assertIn("fintrace.create_ledger_transaction", functions.CREATE_LEDGER_TRANSACTION)
        self.assertIn("fintrace.add_ledger_entry", functions.ADD_LEDGER_ENTRY)
        self.assertIn("fintrace.post_ledger_transaction", functions.POST_LEDGER_TRANSACTION)
        self.assertIn("fintrace.reverse_ledger_transaction", functions.REVERSE_LEDGER_TRANSACTION)
