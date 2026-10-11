import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { useTenant } from '../../providers/TenantProvider';

interface TopbarProps {
  theme: string;
  setTheme: (theme: string) => void;
  setSearchOpen: (open: boolean) => void;
  tenantOpen: boolean;
  setTenantOpen: (open: boolean) => void;
  onLogout: () => void;
  userName: string;
}

export function Topbar({
  theme,
  setTheme,
  setSearchOpen,
  tenantOpen,
  setTenantOpen,
  onLogout,
  userName,
}: TopbarProps) {
  const {
    currentCompany,
    availableCompanies,
    isLoadingCompanies,
    tenantError,
    switchCompany,
    isSwitchingCompany,
  } = useTenant();

  const tenantName = currentCompany?.name || 'No workspace selected';
  const tenantInitials = (tenantName.split(/\s+/).map((p: string) => p[0]?.toUpperCase()).slice(0, 2).join('')) || 'FT';
  const userInitials = (userName.split(/\s+/).map((p: string) => p[0]?.toUpperCase()).slice(0, 2).join('')) || 'US';

  const dispatchAction = (action: string) => {
    window.dispatchEvent(new CustomEvent('fintrace-action', { detail: action }));
  };

  return (
    <header className="topbar">
      <div className="tenant-wrap">
        <button
          className="tenant"
          onClick={(e) => {
            e.stopPropagation();
            setTenantOpen(!tenantOpen);
          }}
          disabled={isLoadingCompanies || isSwitchingCompany}
          aria-label="Switch Workspace"
        >
          <span className="tenant-logo">{tenantInitials}</span>
          <span>
            <small>Workspace</small>
            <strong>{isLoadingCompanies ? 'Loading...' : tenantName}</strong>
          </span>
          <Icon name="chevron" />
        </button>

        {tenantOpen && (
          <div className="popover tenant-menu" role="menu">
            <p className="eyebrow">Workspaces</p>
            {tenantError && <div className="menu-state" role="alert">{tenantError}</div>}
            {!tenantError && !isLoadingCompanies && availableCompanies.length === 0 && (
              <div className="menu-state">You are not a member of any workspace yet.</div>
            )}
            {availableCompanies.map((company) => {
              const selected = currentCompany?.id === company.id;
              const compInitials = company.name.split(/\s+/).map((p: string) => p[0]?.toUpperCase()).slice(0, 2).join('') || 'W';
              return (
                <button
                  key={company.id}
                  className={selected ? 'selected' : ''}
                  disabled={!company.is_member || isSwitchingCompany}
                  aria-current={selected ? 'true' : undefined}
                  onClick={async () => {
                    setTenantOpen(false);
                    if (selected) return;
                    try {
                      await switchCompany(company.id);
                      dispatchAction('Workspace changed');
                    } catch {
                      // The provider records the reason; reopen the menu so it is visible.
                      setTenantOpen(true);
                    }
                  }}
                  role="menuitem"
                >
                  <span className="tenant-logo">{compInitials}</span>
                  <span>
                    <strong>{company.name}</strong>
                    <small>{company.is_member ? company.currency.code : 'You are not a member'}</small>
                  </span>
                  {selected && <Icon name="check" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <button className="search-trigger" onClick={() => setSearchOpen(true)} aria-label="Search">
        <Icon name="search" />
        <span>Go to…</span>
        <kbd>⌘ K</kbd>
      </button>

      <div className="top-actions">
        <Button
          kind="icon"
          ariaLabel="Toggle theme"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </Button>
        <Button kind="ghost" onClick={onLogout}>
          Logout
        </Button>
        <button
          className="avatar avatar-button"
          aria-label="User profile"
          onClick={() => dispatchAction('User menu')}
        >
          {userInitials}
        </button>
      </div>
    </header>
  );
}
