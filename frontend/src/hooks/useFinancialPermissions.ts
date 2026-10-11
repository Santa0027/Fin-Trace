import { useTenant } from '../providers/TenantProvider';

/**
 * What the signed-in user may do in the active workspace.
 *
 * These only decide what the interface offers. The database enforces every one
 * of them again on each request, so hiding a button is never the security.
 * Anything that posts to the ledger also needs transactions.create and
 * transactions.post, because that is what the posting routines check.
 */
export function useFinancialPermissions() {
  const { can, permissionsLoading } = useTenant();
  const canPostToLedger = can('transactions.create') && can('transactions.post');

  return {
    permissionsLoading,
    canViewDashboard: can('dashboard.view') && can('accounts.view') && can('transactions.view'),
    canViewAccounts: can('accounts.view'),
    canCreateAccounts: can('accounts.create'),
    canUpdateAccounts: can('accounts.update'),
    canViewTransactions: can('transactions.view'),
    canTransfer: canPostToLedger,
    canReverseTransactions: can('transactions.reverse'),
    canViewIncome: can('income.view'),
    canCreateIncome: can('income.create') && canPostToLedger,
    canViewExpenses: can('expenses.view'),
    canCreateExpenses: can('expenses.create') && canPostToLedger,
    canViewCategories: can('categories.view'),
    canCreateCategories: can('categories.create'),
    canUpdateCategories: can('categories.update'),
    canViewContacts: can('contacts.view'),
    canCreateContacts: can('contacts.create'),
    canUpdateContacts: can('contacts.update'),
    canViewDebts: can('debts.view'),
    canCreateDebts: can('debts.create') && canPostToLedger,
    canRepayDebts: can('debts.update') && canPostToLedger,
    canViewInvestments: can('investments.view'),
    canCreateInvestments: can('investments.create') && canPostToLedger,
    canManageBroker: can('investments.update'),
    canViewRecurring: can('recurring.view'),
    canCreateRecurring: can('recurring.create'),
    canUpdateRecurring: can('recurring.update'),
    canViewReports: can('transactions.view') && can('accounts.view'),
    canViewMembers: can('memberships.view'),
    canManageMembers: can('memberships.create') && can('memberships.update'),
    canViewActivity: can('audit.view'),
    canUpdateWorkspace: can('settings.update'),
    canRunRecurring: can('recurring.update') && canPostToLedger,
    can,
  };
}
