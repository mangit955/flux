"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { apiGuestLogin, apiLogin, apiRegister, ApiError } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthState {
  token: string | null;
  userId: string | null;
  isLoggedIn: boolean;
}

interface AuthActions {
  login: (email: string, password: string) => Promise<void>;
  loginAsGuest: () => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

type AuthContextValue = AuthState & AuthActions;

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = "flux_auth_token";
const USER_ID_KEY = "flux_user_id";

// ─── Provider ────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // Rehydrate from localStorage on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedToken = localStorage.getItem(TOKEN_KEY);
    const savedUserId = localStorage.getItem(USER_ID_KEY);
    if (savedToken && savedUserId) {
      setToken(savedToken);
      setUserId(savedUserId);
    }
  }, []);

  const persist = useCallback((t: string, uid: string) => {
    setToken(t);
    setUserId(uid);
    if (typeof window !== "undefined") {
      localStorage.setItem(TOKEN_KEY, t);
      localStorage.setItem(USER_ID_KEY, uid);
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await apiLogin(email, password);
      persist(result.token, result.userId);
    },
    [persist],
  );

  const loginAsGuest = useCallback(async () => {
    const result = await apiGuestLogin();
    persist(result.token, result.userId);
  }, [persist]);

  const register = useCallback(
    async (email: string, password: string) => {
      await apiRegister(email, password);
      // Auto-login after successful registration
      const result = await apiLogin(email, password);
      persist(result.token, result.userId);
    },
    [persist],
  );

  const logout = useCallback(() => {
    setToken(null);
    setUserId(null);
    if (typeof window !== "undefined") {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_ID_KEY);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        token,
        userId,
        isLoggedIn: token !== null,
        login,
        loginAsGuest,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}

export { ApiError };
