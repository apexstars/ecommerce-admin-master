import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, refreshSession, setSession, setSessionExpiredHandler } from '../api/client';
import type { Me, PermissionKey } from '../api/types';

type LoginResult = { status: 'ok' } | { status: '2fa_required'; challengeToken: string };

interface AuthState {
  status: 'loading' | 'signed-out' | 'signed-in';
  me: Me | undefined;
  can: (key: PermissionKey) => boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  verifyTwoFactor: (challengeToken: string, code: string) => Promise<void>;
  acceptInvite: (token: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

type SessionResponse = { accessToken: string; expiresIn: number };

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSessionState] = useState<'loading' | 'signed-out' | 'signed-in'>('loading');

  // Restore the session from the refresh cookie on first load.
  useEffect(() => {
    void refreshSession().then((ok) => setSessionState(ok ? 'signed-in' : 'signed-out'));
    setSessionExpiredHandler(() => {
      qc.clear();
      setSessionState('signed-out');
    });
  }, [qc]);

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/me'),
    enabled: session === 'signed-in',
    staleTime: 60_000,
  });

  const start = useCallback((s: SessionResponse) => {
    setSession(s.accessToken, s.expiresIn);
    setSessionState('signed-in');
  }, []);

  const value = useMemo<AuthState>(() => {
    const perms = new Set(meQuery.data?.permissions ?? []);
    return {
      status: session === 'signed-in' && !meQuery.data ? 'loading' : session,
      me: meQuery.data,
      can: (key) => perms.has(key),
      async login(email, password) {
        const res = await api<({ status: 'ok' } & SessionResponse) | { status: '2fa_required'; challengeToken: string }>('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        if (res.status === 'ok') start(res);
        return res;
      },
      async verifyTwoFactor(challengeToken, code) {
        start(await api<SessionResponse>('/auth/2fa/verify', { method: 'POST', body: { challengeToken, code } }));
      },
      async acceptInvite(token, name, password) {
        start(await api<SessionResponse>('/auth/accept-invite', { method: 'POST', body: { token, name, password } }));
      },
      async logout() {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        setSession(null);
        qc.clear();
        setSessionState('signed-out');
      },
    };
  }, [session, meQuery.data, start, qc]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
