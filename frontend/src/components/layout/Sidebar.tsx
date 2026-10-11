import { useMemo } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { useFinancialPermissions } from '../../hooks/useFinancialPermissions';
import type { IconName } from '../../types';

interface NavGroup {
  label?: string;
  items: {
    id: string;
    label: string;
    icon: IconName;
    permission?: string;
  }[];
}

interface SidebarProps {
  page: string;
  setPage: (page: string) => void;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  userName: string;
  userRole: string;
}

export function Sidebar({
  page,
  setPage,
  collapsed,
  setCollapsed,
  userName,
  userRole,
}: SidebarProps) {
  const {
    canViewAccounts,
    canViewTransactions,
    canViewCategories,
    canViewDebts,
    canViewInvestments,
    canViewRecurring,
    canViewReports,
  } = useFinancialPermissions();

  const initials = userName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase())
    .join('') || 'FT';

  const navItems: { id: string; label: string; icon: IconName; visible: boolean }[] = useMemo(
    () => [
      { id: 'Dashboard', label: 'Dashboard', icon: 'home', visible: true },
      { id: 'Accounts', label: 'Accounts', icon: 'wallet', visible: canViewAccounts },
      { id: 'Transactions', label: 'Transactions', icon: 'swap', visible: canViewTransactions },
      { id: 'Recurring', label: 'Recurring', icon: 'repeat', visible: canViewRecurring },
      { id: 'Debts', label: 'Loans', icon: 'debt', visible: canViewDebts },
      { id: 'Investments', label: 'Investments', icon: 'trend', visible: canViewInvestments },
      { id: 'Reports', label: 'Reports', icon: 'chart', visible: canViewReports },
    ],
    [
      canViewAccounts,
      canViewTransactions,
      canViewRecurring,
      canViewDebts,
      canViewInvestments,
      canViewReports,
    ]
  );

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Main Navigation">
      <div className="side-head">
        <div className="logo">
          <span className="logo-mark">
            <i />
            <i />
            <i />
          </span>
          <strong>FINTRACE</strong>
        </div>
        <Button kind="icon" ariaLabel="Collapse sidebar" onClick={() => setCollapsed(!collapsed)}>
          <Icon name="chevron" />
        </Button>
      </div>

      <nav className="nav-list" aria-label="Primary">
        {navItems.filter(item => item.visible).map(item => (
          <button
            key={item.id}
            className={`nav-item ${page === item.id ? 'active' : ''}`}
            onClick={() => setPage(item.id)}
            title={item.label}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="side-bottom">
        <button
          className={`nav-item ${page === 'Settings' ? 'active' : ''}`}
          onClick={() => setPage('Settings')}
          title="Settings"
        >
          <Icon name="settings" />
          <span>Settings</span>
        </button>
        <div className="user-mini">
          <div className="avatar">{initials}</div>
          <div>
            <strong>{userName}</strong>
            <span>{userRole}</span>
          </div>
          <Icon name="more" />
        </div>
      </div>
    </aside>
  );
}
