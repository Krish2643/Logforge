import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { AuthSessionResponse, UserResponse } from "@logforge/shared";
import { ApiError, setBearerToken, setUnauthorizedHandler } from "../../../lib/api-client.js";
import {
  getCurrentUser,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest
} from "../api/auth-client.js";

type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "error";

interface AuthContextValue {
  status: AuthStatus;
  user: UserResponse | null;
  authError: string | null;
  authNotice: string | null;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  restoreSession(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const STORAGE_KEY = "logforge.session-token";

function readSessionToken(): string | null {
  return window.sessionStorage.getItem(STORAGE_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<UserResponse | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    setBearerToken(null);
    window.sessionStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setAuthError(null);
    setAuthNotice(null);
    setStatus("unauthenticated");
  }, []);

  const acceptSession = useCallback((session: AuthSessionResponse) => {
    window.sessionStorage.setItem(STORAGE_KEY, session.accessToken);
    setBearerToken(session.accessToken);
    setUser(session.user);
    setAuthError(null);
    setAuthNotice(null);
    setStatus("authenticated");
  }, []);

  const restoreSession = useCallback(async () => {
    const token = readSessionToken();
    if (!token) {
      setBearerToken(null);
      setUser(null);
      setAuthError(null);
      setStatus("unauthenticated");
      return;
    }

    setBearerToken(token);
    setStatus("loading");
    setAuthError(null);
    try {
      setUser(await getCurrentUser());
      setStatus("authenticated");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearSession();
        return;
      }
      setAuthError(error instanceof Error ? error.message : "Unable to restore your session");
      setStatus("error");
    }
  }, [clearSession]);

  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    void restoreSession();
    return () => setUnauthorizedHandler(null);
  }, [clearSession, restoreSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const session = await loginRequest(email, password);
      acceptSession(session);
    },
    [acceptSession]
  );

  const register = useCallback(
    async (email: string, password: string) => {
      const session = await registerRequest(email, password);
      acceptSession(session);
    },
    [acceptSession]
  );

  const logout = useCallback(async () => {
    let revocationFailed = false;
    try {
      if (readSessionToken()) await logoutRequest();
    } catch {
      revocationFailed = true;
    } finally {
      clearSession();
    }
    if (revocationFailed) {
      setAuthNotice("You were signed out locally, but the server could not confirm session revocation.");
    } else {
      setAuthNotice(null);
    }
  }, [clearSession]);

  const value = useMemo(
    () => ({ status, user, authError, authNotice, login, register, logout, restoreSession }),
    [status, user, authError, authNotice, login, register, logout, restoreSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
