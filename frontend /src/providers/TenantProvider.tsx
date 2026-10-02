import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { apiClient } from "@/lib/api/apiClient";
import { useAuth } from "./AuthProvider";

interface TenantContextType {
  currentCompany: any;
  availableCompanies: any[];
  isLoadingCompanies: boolean;
  permissions: string[];
  permissionsLoading: boolean;
  tenantError: string | null;
  can: (permission: string) => boolean;
  switchCompany: (id: string) => Promise<void>;
  reloadCompanies: () => Promise<void>;
  reloadPermissions: () => Promise<void>;
  isSwitchingCompany: boolean;
}

const TenantContext = createContext<TenantContextType | null>(null);

export function TenantProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [currentCompany, setCurrentCompany] = useState<any>(null);
  const [availableCompanies, setAvailableCompanies] = useState<any[]>([]);
  const [isLoadingCompanies, setIsLoadingCompanies] = useState(false);
  const [isSwitchingCompany, setIsSwitchingCompany] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(false);

  const resetTenant = () => {
    setCurrentCompany(null);
    setAvailableCompanies([]);
    setPermissions([]);
    setTenantError(null);
  };

  const reloadPermissions = async () => {
    if (!isAuthenticated) {
      setPermissions([]);
      return;
    }
    setPermissionsLoading(true);
    try {
      const data = await apiClient("/rbac/effective-permissions/");
      setPermissions((data.results || []).filter((row: any) => row.effect !== "DENY").map((row: any) => row.code));
    } catch (err) {
      setPermissions([]);
      setTenantError(err instanceof Error ? err.message : "Failed to load permissions");
    } finally {
      setPermissionsLoading(false);
    }
  };

  const reloadCompanies = async () => {
    if (!isAuthenticated) {
      resetTenant();
      return;
    }
    setIsLoadingCompanies(true);
    setTenantError(null);
    try {
      const [companiesData, sessionData] = await Promise.all([
        apiClient("/auth/companies/"),
        apiClient("/auth/me/"),
      ]);
      setAvailableCompanies(companiesData.companies || []);
      setCurrentCompany(sessionData.tenant || null);
      await reloadPermissions();
    } catch (err) {
      setTenantError(err instanceof Error ? err.message : "Failed to load companies");
      setAvailableCompanies([]);
      setCurrentCompany(null);
    } finally {
      setIsLoadingCompanies(false);
    }
  };

  useEffect(() => {
    void reloadCompanies();
  }, [isAuthenticated]);

  const switchCompany = async (id: string) => {
    setIsSwitchingCompany(true);
    setTenantError(null);
    try {
      setPermissions([]);
      const data = await apiClient("/auth/switch-tenant/", {
        method: "POST",
        body: JSON.stringify({ company_id: id })
      });
      setCurrentCompany(data.tenant);
      window.dispatchEvent(new CustomEvent("tenant:changed", { detail: data.tenant }));
      await reloadCompanies();
    } catch (err) {
      setTenantError(err instanceof Error ? err.message : "Failed to switch company");
      throw err;
    } finally {
      setIsSwitchingCompany(false);
    }
  };

  return (
    <TenantContext.Provider value={{ currentCompany, availableCompanies, isLoadingCompanies, permissions, permissionsLoading, tenantError, can: (permission: string) => permissions.includes(permission), switchCompany, reloadCompanies, reloadPermissions, isSwitchingCompany }}>
      {children}
    </TenantContext.Provider>
  );
}

export const useTenant = () => {
  const context = useContext(TenantContext);
  if (!context) throw new Error("useTenant must be used within TenantProvider");
  return context;
};
