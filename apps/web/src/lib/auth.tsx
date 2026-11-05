import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicUser } from '@asterius/shared';
import { api, setUnauthorizedHandler, tokenStore } from './api';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  isAdmin: boolean;
  signIn: (token: string) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState(tokenStore.get());
  const me = useQuery({ queryKey: ['me', token], queryFn: api.me, enabled: !!token, retry: false, staleTime: 60_000 });

  const signIn = useCallback(
    (t: string) => {
      tokenStore.set(t);
      setToken(t);
    },
    [setToken],
  );
  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    tokenStore.set(null);
    setToken(null);
    qc.clear();
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      tokenStore.set(null);
      setToken(null);
    });
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user: token ? (me.data ?? null) : null,
      loading: !!token && me.isPending,
      isAdmin: me.data?.role === 'admin',
      signIn,
      signOut,
    }),
    [token, me.data, me.isPending, signIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
