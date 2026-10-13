import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, refreshSession, setAccessToken, type Session } from '@/services/api';
import type { User } from '@/types/api';

interface AuthState {
  user: User | null;
  /** true until the initial silent refresh finishes, so routes do not flash "logged out". */
  initializing: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (input: { name: string; email: string; password: string; role: 'USER' | 'SELLER' }) => Promise<User>;
  logout: () => Promise<void>;
  updateUser: (u: User) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Non-secret hint that this browser has signed in before, so first-time visitors skip the silent
 * refresh call (which would just 401). It holds no credential: the session itself is the HttpOnly cookie.
 */
const SESSION_HINT = 'auctra.hasSession';
const hint = {
  get: () => {
    try {
      return localStorage.getItem(SESSION_HINT) === '1';
    } catch {
      return true; // storage unavailable: just try the refresh
    }
  },
  set: (on: boolean) => {
    try {
      if (on) localStorage.setItem(SESSION_HINT, '1');
      else localStorage.removeItem(SESSION_HINT);
    } catch {
      /* ignore */
    }
  },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  // No hint → nothing to restore, so there is no initial loading phase at all.
  const [initializing, setInitializing] = useState(() => hint.get());
  const queryClient = useQueryClient();

  // Session persistence: the HttpOnly refresh cookie survives reloads; exchange it for a fresh
  // in-memory access token on startup.
  useEffect(() => {
    let cancelled = false;
    if (!hint.get()) return;
    refreshSession()
      .then((s) => {
        if (cancelled) return;
        setUser(s?.user ?? null);
        hint.set(Boolean(s));
      })
      .finally(() => !cancelled && setInitializing(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Proactively refresh shortly before the access token expires.
  useEffect(() => {
    if (!user) return;
    const id = window.setInterval(() => void refreshSession().then((s) => !s && setUser(null)), 12 * 60_000);
    return () => window.clearInterval(id);
  }, [user]);

  const accept = useCallback(
    (s: Session) => {
      setAccessToken(s.accessToken);
      setUser(s.user);
      hint.set(true);
      queryClient.invalidateQueries();
      return s.user;
    },
    [queryClient],
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      initializing,
      login: async (email, password) => accept((await api.post<Session>('/auth/login', { email, password })).data),
      register: async (input) => accept((await api.post<Session>('/auth/register', input)).data),
      logout: async () => {
        await api.post('/auth/logout').catch(() => undefined);
        setAccessToken(null);
        setUser(null);
        hint.set(false);
        queryClient.removeQueries({ queryKey: ['me'] });
        queryClient.removeQueries({ queryKey: ['notifications'] });
        queryClient.removeQueries({ queryKey: ['watchlist'] });
      },
      updateUser: setUser,
    }),
    [user, initializing, accept, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** UX-only role check. The server enforces every permission independently. */
export function canSell(u: User | null) {
  return u?.role === 'SELLER' || u?.role === 'ADMIN';
}
