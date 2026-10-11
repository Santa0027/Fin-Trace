import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, errorMessage } from '@/lib/api/apiClient';
import { authApi } from '@/lib/api/authApi';
import type { Company, PlatformInfo, Session, User } from '@/types';

interface AuthContextType {
  user: User | null;
  platform: PlatformInfo | null;
  /** The workspace the server session is in; the workspace provider takes it from here. */
  sessionTenant: Company | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Set when the session could not be checked at all (not when simply signed out). */
  error: string | null;
  refreshSession: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    setError(null);
    try {
      setSession(await authApi.session());
    } catch (err) {
      setSession(null);
      // 401 just means "not signed in"; anything else is worth telling the user.
      if (!(err instanceof ApiError && err.status === 401)) setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refreshSession().finally(() => setIsLoading(false));
    const handleUnauthorized = () => setSession(null);
    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, [refreshSession]);

  const login = useCallback(async (identifier: string, password: string) => {
    setError(null);
    setSession(await authApi.login(identifier, password));
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setSession(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user: session?.user ?? null,
        platform: session?.platform ?? null,
        sessionTenant: session?.tenant ?? null,
        isAuthenticated: Boolean(session?.user),
        isLoading,
        error,
        refreshSession,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
