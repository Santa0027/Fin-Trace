import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/api/apiClient';
import { authApi } from '@/lib/api/authApi';
import { setWorkspaceCurrency } from '@/lib/money';
import { setWorkspaceTimezone } from '@/lib/dates';
import type { Company } from '@/types';
import { useAuth } from './AuthProvider';

interface TenantContextType {
  currentCompany: Company | null;
  availableCompanies: Company[];
  isLoadingCompanies: boolean;
  permissions: string[];
  permissionsLoading: boolean;
  tenantError: string | null;
  can: (permission: string) => boolean;
  switchCompany: (id: string) => Promise<void>;
  reloadCompanies: () => Promise<void>;
  /** Apply a change made to the active workspace (e.g. its timezone) without a round trip. */
  patchCurrentCompany: (changes: Partial<Company>) => void;
  isSwitchingCompany: boolean;
}

const TenantContext = createContext<TenantContextType | null>(null);

export function TenantProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, sessionTenant } = useAuth();
  const [currentCompany, setCurrentCompany] = useState<Company | null>(null);
  const [availableCompanies, setAvailableCompanies] = useState<Company[]>([]);
  const [isLoadingCompanies, setIsLoadingCompanies] = useState(false);
  const [isSwitchingCompany, setIsSwitchingCompany] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(false);

  const activate = useCallback((company: Company | null) => {
    setWorkspaceCurrency(company?.currency);
    setWorkspaceTimezone(company?.timezone);
    setCurrentCompany(company);
  }, []);

  const loadPermissions = useCallback(async () => {
    setPermissionsLoading(true);
    try {
      const data = await authApi.permissions();
      setPermissions(data.results.filter((row) => row.effect !== 'DENY').map((row) => row.code));
    } catch (err) {
      // Fail closed: with no permissions the UI offers nothing; the backend enforces regardless.
      setPermissions([]);
      setTenantError(errorMessage(err, 'Could not load your permissions.'));
    } finally {
      setPermissionsLoading(false);
    }
  }, []);

  const reloadCompanies = useCallback(async () => {
    setIsLoadingCompanies(true);
    setTenantError(null);
    try {
      const data = await authApi.companies();
      setAvailableCompanies(data.companies);
    } catch (err) {
      setAvailableCompanies([]);
      setTenantError(errorMessage(err, 'Could not load your workspaces.'));
    } finally {
      setIsLoadingCompanies(false);
    }
  }, []);

  const sessionTenantId = sessionTenant?.id ?? '';
  useEffect(() => {
    if (!isAuthenticated) {
      activate(null);
      setAvailableCompanies([]);
      setPermissions([]);
      setTenantError(null);
      return;
    }
    activate(sessionTenant);
    void reloadCompanies();
    if (sessionTenant) void loadPermissions();
    else setPermissions([]);
    // sessionTenant is identified by id; a new object with the same id is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, sessionTenantId]);

  const switchCompany = useCallback(
    async (id: string) => {
      setIsSwitchingCompany(true);
      setTenantError(null);
      try {
        const data = await authApi.switchCompany(id);
        // Drop the old workspace's permissions before anything renders for the new one.
        setPermissions([]);
        activate(data.tenant);
        window.dispatchEvent(new CustomEvent('tenant:changed', { detail: data.tenant }));
        await loadPermissions();
      } catch (err) {
        setTenantError(errorMessage(err, 'Could not switch workspace.'));
        throw err;
      } finally {
        setIsSwitchingCompany(false);
      }
    },
    [activate, loadPermissions]
  );

  const patchCurrentCompany = useCallback(
    (changes: Partial<Company>) => {
      if (currentCompany) activate({ ...currentCompany, ...changes });
    },
    [activate, currentCompany]
  );

  const value = useMemo<TenantContextType>(
    () => ({
      currentCompany,
      availableCompanies,
      isLoadingCompanies,
      permissions,
      permissionsLoading,
      tenantError,
      can: (permission: string) => permissions.includes(permission),
      switchCompany,
      reloadCompanies,
      patchCurrentCompany,
      isSwitchingCompany,
    }),
    [currentCompany, availableCompanies, isLoadingCompanies, permissions, permissionsLoading, tenantError, switchCompany, reloadCompanies, patchCurrentCompany, isSwitchingCompany]
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export const useTenant = () => {
  const context = useContext(TenantContext);
  if (!context) throw new Error('useTenant must be used within TenantProvider');
  return context;
};
