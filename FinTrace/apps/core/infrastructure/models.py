import uuid

from django.db import models


class FintraceModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    class Meta:
        abstract = True
        managed = False


class TenantScopedModel(FintraceModel):
    tenant_id = models.UUIDField()
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField(null=True)

    class Meta:
        abstract = True
        managed = False


class CurrencyModel(FintraceModel):
    code = models.CharField(max_length=3)
    name = models.CharField(max_length=100)
    symbol = models.CharField(max_length=10)
    decimal_places = models.PositiveSmallIntegerField()
    is_active = models.BooleanField()
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."currencies"'
        ordering = ["code"]


from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin

class CustomUserManager(BaseUserManager):
    def create_user(self, username, email, password=None, **extra_fields):
        email = self.normalize_email(email)
        user = self.model(username=username, email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, username, email, password=None, **extra_fields):
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)
        return self.create_user(username, email, password, **extra_fields)

class UserModel(AbstractBaseUser, PermissionsMixin, FintraceModel):
    username = models.CharField(max_length=150, unique=True)
    email = models.EmailField(max_length=254, unique=True)
    password = models.CharField(max_length=255, db_column='password_hash')
    first_name = models.CharField(max_length=150)
    last_name = models.CharField(max_length=150)
    status = models.CharField(max_length=20, default='ACTIVE')
    is_staff = models.BooleanField(default=False)
    is_superuser = models.BooleanField(default=False)
    last_login = models.DateTimeField(null=True, db_column='last_login_at')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = CustomUserManager()

    USERNAME_FIELD = 'username'
    REQUIRED_FIELDS = ['email']

    @property
    def is_active(self):
        return self.status == 'ACTIVE'

    class Meta:
        managed = False
        db_table = '"fintrace"."users"'


class TenantModel(FintraceModel):
    slug = models.CharField(max_length=80)
    name = models.CharField(max_length=255)
    owner_id = models.UUIDField()
    base_currency_id = models.UUIDField()
    status = models.CharField(max_length=20)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."tenants"'


class RbacPageModel(FintraceModel):
    code = models.CharField(max_length=100)
    name = models.CharField(max_length=150)
    is_active = models.BooleanField()
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."rbac_pages"'


class RbacActionModel(FintraceModel):
    code = models.CharField(max_length=50)
    name = models.CharField(max_length=100)
    is_active = models.BooleanField()
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."rbac_actions"'


class RbacPermissionModel(FintraceModel):
    page_id = models.UUIDField()
    action_id = models.UUIDField()
    code = models.CharField(max_length=160)
    description = models.CharField(max_length=255)
    is_active = models.BooleanField()
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."rbac_permissions"'


class RbacRoleModel(FintraceModel):
    tenant_id = models.UUIDField(null=True)
    code = models.CharField(max_length=100)
    name = models.CharField(max_length=150)
    description = models.TextField()
    is_system = models.BooleanField()
    is_active = models.BooleanField()
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."rbac_roles"'


class TenantMembershipModel(TenantScopedModel):
    user_id = models.UUIDField()
    status = models.CharField(max_length=20)
    invited_at = models.DateTimeField()
    joined_at = models.DateTimeField(null=True)
    left_at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = '"fintrace"."tenant_memberships"'


class RbacRolePermissionModel(models.Model):
    role_id = models.UUIDField(primary_key=True)
    permission_id = models.UUIDField()
    access_scope = models.CharField(max_length=20)
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."rbac_role_permissions"'


class RbacMembershipRoleModel(models.Model):
    membership_id = models.UUIDField(primary_key=True)
    role_id = models.UUIDField()
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."rbac_membership_roles"'


class RbacUserPermissionOverrideModel(FintraceModel):
    membership_id = models.UUIDField()
    permission_id = models.UUIDField()
    effect = models.CharField(max_length=10)
    access_scope = models.CharField(max_length=20)
    expires_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."rbac_user_permission_overrides"'


class IdempotencyOperationModel(TenantScopedModel):
    user_id = models.UUIDField(null=True)
    operation_scope = models.CharField(max_length=150)
    operation_key = models.CharField(max_length=255)
    request_fingerprint = models.CharField(max_length=64)
    status = models.CharField(max_length=20)
    response_status = models.PositiveSmallIntegerField(null=True)
    response_payload = models.JSONField(null=True)
    operation_id = models.UUIDField(null=True)
    locked_until = models.DateTimeField(null=True)
    completed_at = models.DateTimeField(null=True)
    failed_at = models.DateTimeField(null=True)
    expires_at = models.DateTimeField()
    failure_reason = models.TextField()

    class Meta:
        managed = False
        db_table = '"fintrace"."idempotency_operations"'


class AuditEventModel(FintraceModel):
    tenant_id = models.UUIDField()
    actor_user_id = models.UUIDField()
    action = models.CharField(max_length=100)
    entity_type = models.CharField(max_length=120)
    entity_id = models.UUIDField(null=True)
    request_id = models.UUIDField(null=True)
    before_data = models.JSONField(null=True)
    after_data = models.JSONField(null=True)
    metadata = models.JSONField()
    ip_address = models.GenericIPAddressField(null=True)
    user_agent = models.TextField()
    occurred_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."audit_events"'


class CategoryModel(TenantScopedModel):
    name = models.CharField(max_length=100)
    type = models.CharField(max_length=20)
    parent_id = models.UUIDField(null=True)
    is_active = models.BooleanField()
    archived_at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = '"fintrace"."categories"'


class TagModel(TenantScopedModel):
    name = models.CharField(max_length=50)
    color = models.CharField(max_length=7)
    is_active = models.BooleanField()
    archived_at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = '"fintrace"."tags"'


class ContactModel(TenantScopedModel):
    name = models.CharField(max_length=255)
    email = models.EmailField(max_length=254, null=True)
    phone = models.CharField(max_length=50, null=True)
    notes = models.TextField()
    status = models.CharField(max_length=20)

    class Meta:
        managed = False
        db_table = '"fintrace"."contacts"'


class AccountModel(TenantScopedModel):
    name = models.CharField(max_length=255)
    type = models.CharField(max_length=30)
    normal_balance = models.CharField(max_length=10)
    institution = models.CharField(max_length=255)
    account_number = models.CharField(max_length=100)
    currency_id = models.UUIDField()
    is_active = models.BooleanField()
    is_system = models.BooleanField()
    archived_at = models.DateTimeField(null=True)
    notes = models.TextField()

    class Meta:
        managed = False
        db_table = '"fintrace"."accounts"'


class LedgerTransactionModel(TenantScopedModel):
    occurred_at = models.DateTimeField()
    reference = models.CharField(max_length=255)
    description = models.TextField()
    status = models.CharField(max_length=20)
    reverses_transaction_id = models.UUIDField(null=True)

    class Meta:
        managed = False
        db_table = '"fintrace"."ledger_transactions"'


class LedgerEntryModel(TenantScopedModel):
    transaction_id = models.UUIDField()
    account_id = models.UUIDField()
    amount = models.DecimalField(max_digits=28, decimal_places=8)
    debit_amount = models.DecimalField(max_digits=28, decimal_places=8)
    credit_amount = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    exchange_rate = models.DecimalField(max_digits=28, decimal_places=12)
    base_amount = models.DecimalField(max_digits=28, decimal_places=8)

    class Meta:
        managed = False
        db_table = '"fintrace"."ledger_entries"'


class IncomeRecordModel(TenantScopedModel):
    ledger_transaction_id = models.UUIDField()
    category_id = models.UUIDField()
    contact_id = models.UUIDField(null=True)
    amount = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    occurred_on = models.DateField()
    notes = models.TextField()

    class Meta:
        managed = False
        db_table = '"fintrace"."income_records"'


class IncomeTagModel(models.Model):
    tenant_id = models.UUIDField(primary_key=True)
    income_id = models.UUIDField()
    tag_id = models.UUIDField()
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."income_tags"'


class ExpenseRecordModel(TenantScopedModel):
    ledger_transaction_id = models.UUIDField()
    category_id = models.UUIDField()
    contact_id = models.UUIDField(null=True)
    amount = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    occurred_on = models.DateField()
    notes = models.TextField()

    class Meta:
        managed = False
        db_table = '"fintrace"."expense_records"'


class ExpenseTagModel(models.Model):
    tenant_id = models.UUIDField(primary_key=True)
    expense_id = models.UUIDField()
    tag_id = models.UUIDField()
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."expense_tags"'


class DebtModel(TenantScopedModel):
    type = models.CharField(max_length=20)
    contact_id = models.UUIDField()
    principal_amount = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    interest_rate = models.DecimalField(max_digits=8, decimal_places=4)
    start_date = models.DateField()
    due_date = models.DateField(null=True)
    status = models.CharField(max_length=20)
    notes = models.TextField()

    class Meta:
        managed = False
        db_table = '"fintrace"."debts"'


class DebtRepaymentModel(TenantScopedModel):
    debt_id = models.UUIDField()
    ledger_transaction_id = models.UUIDField()
    principal_amount = models.DecimalField(max_digits=28, decimal_places=8)
    interest_amount = models.DecimalField(max_digits=28, decimal_places=8)
    total_amount = models.DecimalField(max_digits=28, decimal_places=8)
    repaid_on = models.DateField()
    notes = models.TextField()

    class Meta:
        managed = False
        db_table = '"fintrace"."debt_repayments"'


class InvestmentPortfolioModel(TenantScopedModel):
    name = models.CharField(max_length=255)
    currency_id = models.UUIDField()
    broker = models.CharField(max_length=255)
    is_active = models.BooleanField()
    archived_at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = '"fintrace"."investment_portfolios"'


class InvestmentInstrumentModel(FintraceModel):
    tenant_id = models.UUIDField(null=True)
    symbol = models.CharField(max_length=50)
    name = models.CharField(max_length=255)
    instrument_type = models.CharField(max_length=30)
    currency_id = models.UUIDField()
    exchange_code = models.CharField(max_length=50)
    is_active = models.BooleanField()
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."investment_instruments"'


class InvestmentPositionModel(TenantScopedModel):
    portfolio_id = models.UUIDField()
    instrument_id = models.UUIDField()
    quantity = models.DecimalField(max_digits=24, decimal_places=8)
    average_cost = models.DecimalField(max_digits=28, decimal_places=8)

    class Meta:
        managed = False
        db_table = '"fintrace"."investment_positions"'


class InvestmentTradeModel(TenantScopedModel):
    portfolio_id = models.UUIDField()
    instrument_id = models.UUIDField()
    ledger_transaction_id = models.UUIDField()
    trade_type = models.CharField(max_length=10)
    quantity = models.DecimalField(max_digits=24, decimal_places=8)
    price = models.DecimalField(max_digits=19, decimal_places=6)
    fees = models.DecimalField(max_digits=28, decimal_places=8)
    realized_pnl = models.DecimalField(max_digits=28, decimal_places=8)
    traded_at = models.DateTimeField()
    cash_account_id = models.UUIDField(null=True)
    investment_account_id = models.UUIDField(null=True)
    realized_pnl_account_id = models.UUIDField(null=True)

    class Meta:
        managed = False
        db_table = '"fintrace"."investment_trades"'


class InvestmentDividendModel(TenantScopedModel):
    portfolio_id = models.UUIDField()
    instrument_id = models.UUIDField()
    ledger_transaction_id = models.UUIDField()
    amount = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    paid_on = models.DateField()
    notes = models.TextField()
    cash_account_id = models.UUIDField(null=True)
    income_account_id = models.UUIDField(null=True)

    class Meta:
        managed = False
        db_table = '"fintrace"."investment_dividends"'


class AssetModel(TenantScopedModel):
    name = models.CharField(max_length=255)
    type = models.CharField(max_length=30)
    purchase_value = models.DecimalField(max_digits=28, decimal_places=8)
    purchase_date = models.DateField(null=True)
    currency_id = models.UUIDField()
    notes = models.TextField()
    archived_at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = '"fintrace"."assets"'


class AssetValuationModel(FintraceModel):
    tenant_id = models.UUIDField()
    asset_id = models.UUIDField()
    value = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    valued_on = models.DateField()
    source = models.CharField(max_length=30)
    notes = models.TextField()
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."asset_valuations"'


class GoalModel(TenantScopedModel):
    name = models.CharField(max_length=255)
    target_amount = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    target_date = models.DateField(null=True)
    priority = models.IntegerField()
    status = models.CharField(max_length=20)
    notes = models.TextField()

    class Meta:
        managed = False
        db_table = '"fintrace"."goals"'


class GoalContributionModel(FintraceModel):
    tenant_id = models.UUIDField()
    goal_id = models.UUIDField()
    ledger_transaction_id = models.UUIDField()
    amount = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    contributed_on = models.DateField()
    notes = models.TextField()
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."goal_contributions"'


class SubscriptionModel(TenantScopedModel):
    name = models.CharField(max_length=255)
    amount = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    frequency = models.CharField(max_length=20)
    start_date = models.DateField()
    next_billing_date = models.DateField()
    end_date = models.DateField(null=True)
    account_id = models.UUIDField(null=True)
    category_id = models.UUIDField(null=True)
    contact_id = models.UUIDField(null=True)
    is_active = models.BooleanField()
    notes = models.TextField()

    class Meta:
        managed = False
        db_table = '"fintrace"."subscriptions"'


class RecurringTransactionModel(TenantScopedModel):
    subscription_id = models.UUIDField(null=True)
    transaction_type = models.CharField(max_length=20)
    source_account_id = models.UUIDField(null=True)
    destination_account_id = models.UUIDField(null=True)
    amount = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    category_id = models.UUIDField(null=True)
    description = models.CharField(max_length=255)
    frequency = models.CharField(max_length=20)
    start_date = models.DateField()
    end_date = models.DateField(null=True)
    next_run_at = models.DateField()
    timezone = models.CharField(max_length=64)
    is_active = models.BooleanField()

    class Meta:
        managed = False
        db_table = '"fintrace"."recurring_transactions"'


class RecurringTransactionOccurrenceModel(TenantScopedModel):
    recurring_transaction_id = models.UUIDField()
    scheduled_for = models.DateField()
    status = models.CharField(max_length=20)
    operation_id = models.UUIDField()
    ledger_transaction_id = models.UUIDField(null=True)
    attempt_count = models.IntegerField()
    locked_until = models.DateTimeField(null=True)
    executed_at = models.DateTimeField(null=True)
    failure_reason = models.TextField()

    class Meta:
        managed = False
        db_table = '"fintrace"."recurring_transaction_occurrences"'


class SecurityConfigModel(models.Model):
    singleton = models.BooleanField(primary_key=True)
    context_hmac_secret = models.BinaryField()
    created_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."security_config"'


class SecurityAuditEventModel(FintraceModel):
    actor_user_id = models.UUIDField(null=True)
    subject_user_id = models.UUIDField()
    action = models.CharField(max_length=100)
    before_data = models.JSONField(null=True)
    after_data = models.JSONField(null=True)
    request_id = models.UUIDField(null=True)
    database_user = models.TextField()
    occurred_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."security_audit_events"'


class AccountBalanceModel(models.Model):
    account_id = models.UUIDField(primary_key=True)
    tenant_id = models.UUIDField()
    name = models.CharField(max_length=255)
    type = models.CharField(max_length=30)
    normal_balance = models.CharField(max_length=10)
    currency_id = models.UUIDField()
    balance_amount = models.DecimalField(max_digits=28, decimal_places=8)
    balance_base_amount = models.DecimalField(max_digits=28, decimal_places=8)

    class Meta:
        managed = False
        db_table = '"fintrace"."account_balances"'


class UnbalancedTransactionModel(models.Model):
    transaction_id = models.UUIDField(primary_key=True)
    tenant_id = models.UUIDField()
    status = models.CharField(max_length=20)
    line_count = models.IntegerField()
    total_debits = models.DecimalField(max_digits=28, decimal_places=8)
    total_credits = models.DecimalField(max_digits=28, decimal_places=8)

    class Meta:
        managed = False
        db_table = '"fintrace"."unbalanced_transactions"'


class DebtBalanceModel(models.Model):
    debt_id = models.UUIDField(primary_key=True)
    tenant_id = models.UUIDField()
    type = models.CharField(max_length=20)
    contact_id = models.UUIDField()
    principal_amount = models.DecimalField(max_digits=28, decimal_places=8)
    repaid_principal = models.DecimalField(max_digits=28, decimal_places=8)
    outstanding_principal = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    status = models.CharField(max_length=20)
    start_date = models.DateField()
    due_date = models.DateField(null=True)

    class Meta:
        managed = False
        db_table = '"fintrace"."debt_balances"'


class GoalProgressModel(models.Model):
    goal_id = models.UUIDField(primary_key=True)
    tenant_id = models.UUIDField()
    name = models.CharField(max_length=255)
    target_amount = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    contributed_amount = models.DecimalField(max_digits=28, decimal_places=8)
    remaining_amount = models.DecimalField(max_digits=28, decimal_places=8)
    progress_percent = models.DecimalField(max_digits=28, decimal_places=8)
    target_date = models.DateField(null=True)
    priority = models.IntegerField()
    status = models.CharField(max_length=20)

    class Meta:
        managed = False
        db_table = '"fintrace"."goal_progress"'


class AssetCurrentValuationModel(models.Model):
    asset_id = models.UUIDField(primary_key=True)
    tenant_id = models.UUIDField()
    value = models.DecimalField(max_digits=28, decimal_places=8)
    currency_id = models.UUIDField()
    valued_on = models.DateField()
    source = models.CharField(max_length=30)

    class Meta:
        managed = False
        db_table = '"fintrace"."asset_current_valuations"'


class InvestmentPositionSummaryModel(models.Model):
    position_id = models.UUIDField(primary_key=True)
    tenant_id = models.UUIDField()
    portfolio_id = models.UUIDField()
    instrument_id = models.UUIDField()
    quantity = models.DecimalField(max_digits=24, decimal_places=8)
    average_cost = models.DecimalField(max_digits=28, decimal_places=8)
    symbol = models.CharField(max_length=50)
    instrument_name = models.CharField(max_length=255)
    instrument_currency_id = models.UUIDField()
    updated_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = '"fintrace"."investment_position_summary"'


class DataIntegrityIssueModel(models.Model):
    issue_type = models.CharField(max_length=100)
    entity_id = models.UUIDField(primary_key=True)
    tenant_id = models.UUIDField()
    details = models.JSONField()

    class Meta:
        managed = False
        db_table = '"fintrace"."data_integrity_issues"'


class TenantUserModel(models.Model):
    id = models.UUIDField(primary_key=True)
    username = models.CharField(max_length=150)
    email = models.EmailField(max_length=254)
    first_name = models.CharField(max_length=150)
    last_name = models.CharField(max_length=150)
    status = models.CharField(max_length=20)
    last_login_at = models.DateTimeField(null=True)
    tenant_id = models.UUIDField()
    membership_status = models.CharField(max_length=20)
    joined_at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = '"fintrace"."tenant_users"'
