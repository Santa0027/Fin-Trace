from django.urls import path

from FinTrace.apps.core.presentation import auth_views, views, health_views

app_name = "core"

RESOURCE_MAP = {
    "tenants": "tenants",
    "memberships": "memberships",
    "accounts": "accounts",
    "categories": "categories",
    "tags": "tags",
    "contacts": "contacts",
    "debts": "debts",
    "investments/portfolios": "investment-portfolios",
    "investments/instruments": "investment-instruments",
    "assets": "assets",
    "goals": "goals",
    "subscriptions": "subscriptions",
    "recurring-transactions": "recurring-transactions",
}

urlpatterns = [
    path("health/live/", health_views.LiveView.as_view(), name="health-live"),
    path("health/ready/", health_views.ReadyView.as_view(), name="health-ready"),

    path("v1/auth/login/", auth_views.LoginView.as_view(), name="auth-login"),
    path("v1/auth/logout/", auth_views.LogoutView.as_view(), name="auth-logout"),
    path("v1/auth/me/", auth_views.MeView.as_view(), name="auth-me"),
    path("v1/auth/csrf/", auth_views.CsrfView.as_view(), name="auth-csrf"),
    path("v1/auth/companies/", auth_views.CompaniesView.as_view(), name="auth-companies"),
    path("v1/auth/switch-tenant/", auth_views.SwitchTenantView.as_view(), name="auth-switch-tenant"),

    path("v1/currencies/", views.CurrencyListView.as_view(), name="currency-list"),
    path("v1/transactions/", views.LedgerTransactionView.as_view(), name="transaction-list-create"),
    path("v1/transactions/<uuid:transaction_id>/", views.LedgerTransactionDetailView.as_view(), name="transaction-detail"),
    path("v1/transactions/<uuid:transaction_id>/entries/", views.LedgerEntryCreateView.as_view(), name="transaction-entry-create"),
    path("v1/transactions/<uuid:transaction_id>/entries/<uuid:entry_id>/", views.LedgerEntryDeleteView.as_view(), name="transaction-entry-delete"),
    path("v1/transactions/<uuid:transaction_id>/post/", views.LedgerPostView.as_view(), name="transaction-post"),
    path("v1/transactions/<uuid:transaction_id>/cancel/", views.LedgerCancelView.as_view(), name="transaction-cancel"),
    path("v1/transactions/<uuid:transaction_id>/reverse/", views.LedgerReverseView.as_view(), name="transaction-reverse"),
    path("v1/income/", views.IncomeCreateView.as_view(), name="income-list-create"),
    path("v1/income/<uuid:row_id>/", views.IncomeDetailView.as_view(), name="income-detail"),
    path("v1/expenses/", views.ExpenseCreateView.as_view(), name="expense-list-create"),
    path("v1/expenses/<uuid:row_id>/", views.ExpenseDetailView.as_view(), name="expense-detail"),
    path("v1/debts/<uuid:row_id>/repayments/", views.DebtRepaymentView.as_view(), name="debt-repayment-create"),
    path("v1/reports/<slug:report_name>/", views.ReportView.as_view(), name="report-list"),

    path("v1/rbac/pages/", type("RBACPagesView", (views.RBACListView,), {"collection": "pages"}).as_view(), name="rbac-pages"),
    path("v1/rbac/actions/", type("RBACActionsView", (views.RBACListView,), {"collection": "actions"}).as_view(), name="rbac-actions"),
    path("v1/rbac/permissions/", type("RBACPermissionsView", (views.RBACListView,), {"collection": "permissions"}).as_view(), name="rbac-permissions"),
    path("v1/rbac/roles/", type("RBACRolesView", (views.RBACListView,), {"collection": "roles"}).as_view(), name="rbac-roles"),
    path("v1/rbac/roles/<uuid:role_id>/permissions/", views.RBACRolePermissionView.as_view(), name="rbac-role-permission-assign"),
    path("v1/rbac/roles/<uuid:role_id>/permissions/<uuid:permission_id>/", views.RBACRolePermissionView.as_view(), name="rbac-role-permission-remove"),
    path("v1/memberships/<uuid:membership_id>/roles/", views.RBACMembershipRoleView.as_view(), name="membership-role-assign"),
    path("v1/memberships/<uuid:membership_id>/roles/<uuid:role_id>/", views.RBACMembershipRoleView.as_view(), name="membership-role-remove"),
    path("v1/memberships/<uuid:membership_id>/permission-overrides/", views.RBACOverrideView.as_view(), name="membership-override-create"),
    path("v1/rbac/permission-overrides/<uuid:override_id>/", views.RBACOverrideView.as_view(), name="membership-override-remove"),
    path("v1/rbac/effective-permissions/", views.EffectivePermissionsView.as_view(), name="effective-permissions"),
    path("v1/income/<uuid:row_id>/tags/", views.IncomeTagsView.as_view(), name="income-tags"),
    path("v1/income/<uuid:row_id>/tags/<uuid:tag_id>/", views.IncomeTagDetailView.as_view(), name="income-tag-detail"),
    path("v1/expenses/<uuid:row_id>/tags/", views.ExpenseTagsView.as_view(), name="expense-tags"),
    path("v1/expenses/<uuid:row_id>/tags/<uuid:tag_id>/", views.ExpenseTagDetailView.as_view(), name="expense-tag-detail"),
    path("v1/investments/trades/", views.InvestmentTradeView.as_view(), name="investment-trade-create"),
    path("v1/investments/dividends/", views.InvestmentDividendView.as_view(), name="investment-dividend-create"),
    path("v1/assets/<uuid:row_id>/valuations/", views.AssetValuationView.as_view(), name="asset-valuations"),
    path("v1/goals/<uuid:row_id>/contributions/", views.GoalContributionView.as_view(), name="goal-contributions"),
    path("v1/audit/", views.AuditListView.as_view(), name="audit-list"),
    path("v1/security-audit/", views.SecurityAuditListView.as_view(), name="security-audit-list"),
    path("v1/security-config/", views.SecurityConfigStatusView.as_view(), name="security-config-status"),
    path("v1/recurring-occurrences/", views.RecurringOccurrenceListView.as_view(), name="recurring-occurrences"),
]

for route, resource in RESOURCE_MAP.items():
    collection = type(f"{resource.title().replace('-', '')}CollectionView", (views.ResourceCollectionView,), {"resource": resource})
    detail = type(f"{resource.title().replace('-', '')}DetailView", (views.ResourceDetailView,), {"resource": resource})
    archive = type(f"{resource.title().replace('-', '')}ArchiveView", (views.ResourceArchiveView,), {"resource": resource})
    urlpatterns.extend([
        path(f"v1/{route}/", collection.as_view(), name=f"{resource}-list-create"),
        path(f"v1/{route}/<uuid:row_id>/", detail.as_view(), name=f"{resource}-detail"),
        path(f"v1/{route}/<uuid:row_id>/archive/", archive.as_view(), name=f"{resource}-archive"),
    ])
