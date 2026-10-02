import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { apiClient } from "@/lib/api/apiClient";

interface AuthContextType {
  user: any;
  platform: any;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  refreshSession: () => Promise<void>;
  login: (credentials: any) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState(null);
  const [platform, setPlatform] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const clearSession = () => {
    setUser(null);
    setPlatform(null);
  };

  const refreshSession = async () => {
    setError(null);
    try {
      await apiClient("/auth/csrf/");
      const data = await apiClient("/auth/me/");
      if (data.authenticated) {
        setUser(data.user);
        setPlatform(data.platform);
      } else {
        clearSession();
      }
    } catch (err) {
      clearSession();
      if (err instanceof Error && !err.message.includes("401")) setError(err.message);
    }
  };

  useEffect(() => {
    const fetchSession = async () => {
      try {
        await refreshSession();
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchSession();
    
    const handleUnauthorized = () => {
      clearSession();
    };
    window.addEventListener("auth:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", handleUnauthorized);
  }, []);

  const login = async (credentials: any) => {
    setError(null);
    await apiClient("/auth/csrf/");
    await apiClient("/auth/login/", {
      method: "POST",
      body: JSON.stringify(credentials)
    });
    const data = await apiClient("/auth/me/");
    setUser(data.user);
    setPlatform(data.platform);
  };

  const logout = async () => {
    try {
      await apiClient("/auth/logout/", { method: "POST" });
    } finally {
      clearSession();
    }
  };

  return (
    <AuthContext.Provider value={{ user, platform, isAuthenticated: !!user, isLoading, error, refreshSession, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
};
