import { useState, useEffect, useMemo, type FormEvent } from 'react';
import { Sidebar } from '../components/layout/Sidebar';
import { Topbar } from '../components/layout/Topbar';
import { Icon } from '../components/common/Icon';
import { Button } from '../components/common/Button';
import { TransactionDrawer } from '../components/modals/TransactionDrawer';
import { TransactionChooserModal } from '../components/modals/TransactionChooserModal';
import { SearchModal } from '../components/modals/SearchModal';
import { DashboardPage } from '../pages/DashboardPage';
import { AccountsPage } from '../pages/AccountsPage';
import { TransactionsPage } from '../pages/TransactionsPage';
import { IncomePage } from '../pages/IncomePage';
import { ExpensesPage } from '../pages/ExpensesPage';
import { TransfersPage } from '../pages/TransfersPage';
import { DebtsPage } from '../pages/DebtsPage';
import { InvestmentsPage } from '../pages/InvestmentsPage';
import { RecurringPage } from '../pages/RecurringPage';
import { ReportsPage } from '../pages/ReportsPage';
import { CategoriesPage } from '../pages/CategoriesPage';
import { ContactsPage } from '../pages/ContactsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { useAuth } from '../providers/AuthProvider';
import { useTenant } from '../providers/TenantProvider';
import { errorMessage } from '../lib/api/apiClient';
import type { IconName } from '../types';

function Toast({ message, close }: { message: string; close: () => void }) {
  return (
    <div className="toast" role="status">
      <span>
        <Icon name="check" />
      </span>
      <div>
        <strong>{message}</strong>
        <small>Balances and reports are up to date.</small>
      </div>
      <Button kind="icon" ariaLabel="Dismiss notification" onClick={close}>
        <Icon name="close" />
      </Button>
    </div>
  );
}

function LoginPage() {
  const { login, isLoading, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setSubmitError(errorMessage(err, 'Sign-in failed. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-screen">
      <form className="auth-card card" onSubmit={submit}>
        <div className="logo" style={{ marginBottom: '12px' }}>
          <span className="logo-mark">
            <i />
            <i />
            <i />
          </span>
          <strong>FINTRACE</strong>
        </div>
        <div>
          <h1>Sign in to FinTrace</h1>
          <p>Track what you earn, spend, own and owe.</p>
        </div>
        {(submitError || error) && <div className="auth-error" role="alert">{submitError || error}</div>}
        <label className="field">
          Email or username
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            disabled={submitting || isLoading}
          />
        </label>
        <label className="field">
          Password
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
            required
            disabled={submitting || isLoading}
          />
        </label>
        <button
          className="btn btn-primary auth-submit"
          type="submit"
          disabled={submitting || isLoading}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

export default function App() {
  const { user, platform, isAuthenticated, isLoading, logout } = useAuth();
  const { currentCompany } = useTenant();

  const [page, setPage] = useState('Dashboard');
  const [theme, setTheme] = useState('light');
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tenantOpen, setTenantOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [drawerType, setDrawerType] = useState('');
  const [toast, setToast] = useState('');

  const userName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.username ||
    user?.email ||
    '';
  const userRole = platform?.is_superuser ? 'Platform admin' : currentCompany?.name ?? '';

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  };

  const runAction = (action: string) => {
    const normalized = action.trim();
    if (['Add expense', 'Add income', 'Add transaction', 'Transfer money'].includes(normalized)) {
      setDrawerType(normalized === 'Add transaction' ? 'Add expense' : normalized);
      return;
    }
    if (normalized === 'Investments' || normalized === 'Debts') {
      setPage(normalized);
      return;
    }
    if (normalized === 'View report' || normalized === 'Export report') {
      setPage('Reports');
      return;
    }
    if (normalized === 'View all' || normalized.includes('transactions')) {
      setPage('Transactions');
      return;
    }
    if (normalized === 'Manage' || normalized.includes('account details') || normalized === 'Add account') {
      setPage('Accounts');
      return;
    }
    if (normalized === 'Search accounts' || normalized === 'Search transactions') {
      setSearchOpen(true);
      return;
    }
    if (normalized === 'User menu') {
      setPage('Settings');
      return;
    }
    if (normalized === 'Workspace changed') {
      setDrawerType('');
      setChooserOpen(false);
      setPage('Dashboard');
      showToast('Workspace switched');
      return;
    }
  };

  // Coming back from Zerodha's sign-in page: show the result once, then tidy the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('broker') !== 'zerodha') return;
    const result = params.get('result');
    setPage('Investments');
    setToast(result === 'connected' ? 'Zerodha connected' : params.get('message') || 'Zerodha was not connected');
    window.setTimeout(() => setToast(''), 6000);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setSearchOpen(false);
        setChooserOpen(false);
        setDrawerType('');
        setTenantOpen(false);
      }
    };

    const actionHandler = (e: Event) => runAction((e as CustomEvent<string>).detail);

    window.addEventListener('keydown', keyHandler);
    window.addEventListener('fintrace-action', actionHandler);

    return () => {
      window.removeEventListener('keydown', keyHandler);
      window.removeEventListener('fintrace-action', actionHandler);
    };
  }, []);

  const content = useMemo(() => {
    switch (page) {
      case 'Dashboard':
        return (
          <DashboardPage
            setPage={setPage}
            openExpense={() => setDrawerType('Add expense')}
            openIncome={() => setDrawerType('Add income')}
            openChooser={() => setChooserOpen(true)}
          />
        );
      case 'Accounts':
      case 'Account details':
        return <AccountsPage />;
      case 'Transactions':
        return (
          <TransactionsPage
            openExpense={() => setDrawerType('Add expense')}
            openIncome={() => setDrawerType('Add income')}
            openTransfer={() => setDrawerType('Transfer money')}
            openChooser={() => setChooserOpen(true)}
          />
        );
      case 'Income':
        return <IncomePage openIncome={() => setDrawerType('Add income')} />;
      case 'Expenses':
        return <ExpensesPage openExpense={() => setDrawerType('Add expense')} />;
      case 'Transfers':
        return <TransfersPage openTransfer={() => setDrawerType('Transfer money')} />;
      case 'Debts':
        return <DebtsPage />;
      case 'Investments':
      case 'Investment integrations':
        return <InvestmentsPage />;
      case 'Recurring':
        return <RecurringPage />;
      case 'Reports':
        return <ReportsPage />;
      case 'Categories':
        return <CategoriesPage />;
      case 'Contacts':
        return <ContactsPage />;
      case 'Settings':
        return <SettingsPage setPage={setPage} />;
      default:
        return (
          <DashboardPage
            setPage={setPage}
            openExpense={() => setDrawerType('Add expense')}
            openIncome={() => setDrawerType('Add income')}
            openChooser={() => setChooserOpen(true)}
          />
        );
    }
  }, [page]);

  if (isLoading) {
    return (
      <main className="auth-screen">
        <div className="auth-card card">
          <div className="logo">
            <span className="logo-mark">
              <i />
              <i />
              <i />
            </span>
            <strong>FINTRACE</strong>
          </div>
          <div className="app-state">Checking authenticated session...</div>
        </div>
      </main>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div
      className={theme === 'dark' ? 'app dark' : 'app'}
      onClick={() => tenantOpen && setTenantOpen(false)}
    >
      <Sidebar
        page={page}
        setPage={setPage}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        userName={userName}
        userRole={userRole}
      />

      <div className="main-shell">
        <Topbar
          theme={theme}
          setTheme={setTheme}
          setSearchOpen={setSearchOpen}
          tenantOpen={tenantOpen}
          setTenantOpen={setTenantOpen}
          onLogout={logout}
          userName={userName}
        />

        <main className="content">{content}</main>
      </div>

      {/* Mobile Bottom Navigation */}
      <nav className="mobile-nav" aria-label="Mobile Navigation">
        {([
          ['Dashboard', 'home'],
          ['Accounts', 'wallet'],
          ['Transactions', 'swap'],
          ['Investments', 'trend'],
          ['More', 'more'],
        ] as [string, IconName][]).map(([label, icon]) => (
          <button
            key={label}
            className={page === (label === 'More' ? 'Settings' : label) ? 'active' : ''}
            onClick={() => setPage(label === 'More' ? 'Settings' : label)}
          >
            <Icon name={icon} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {searchOpen && (
        <SearchModal
          close={() => setSearchOpen(false)}
          setPage={setPage}
          act={runAction}
        />
      )}

      {chooserOpen && (
        <TransactionChooserModal
          close={() => setChooserOpen(false)}
          onSelect={(selectedType) => {
            setChooserOpen(false);
            if (selectedType === 'Investments') {
              setPage('Investments');
            } else if (selectedType === 'Debts') {
              setPage('Debts');
            } else {
              setDrawerType(selectedType);
            }
          }}
        />
      )}

      {drawerType && (
        <TransactionDrawer
          type={drawerType}
          close={() => setDrawerType('')}
          saved={async () => {
            setDrawerType('');
            showToast(drawerType === 'Transfer money' ? 'Transfer saved' : drawerType === 'Add income' ? 'Income saved' : 'Expense saved');
          }}
        />
      )}

      {toast && <Toast message={toast} close={() => setToast('')} />}
    </div>
  );
}
