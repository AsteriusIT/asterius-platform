import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgRef, PublicUser } from '@asterius/shared';
import { api, orgStore, setUnauthorizedHandler, tokenStore } from './api';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  /** Admin of the current organization (super-admins are admins everywhere). */
  isAdmin: boolean;
  isSuperadmin: boolean;
  /** Organization the UI works in; null: the account has none yet. */
  org: OrgRef | null;
  signIn: (token: string) => void;
  signOut: () => Promise<void>;
  /** Work in another organization: every cached page is dropped and reloaded for it. */
  switchOrg: (slug: string) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState(tokenStore.get());
  const [orgKey, setOrgKey] = useState(orgStore.get());
  const me = useQuery({ queryKey: ['me', token, orgKey], queryFn: api.me, enabled: !!token, retry: false, staleTime: 60_000 });

  // Remember the organization the server settled on (first sign-in, removed from the remembered one…).
  useEffect(() => {
    const slug = me.data?.organization?.slug ?? null;
    if (me.data && slug !== orgStore.get()) orgStore.set(slug);
  }, [me.data]);

  const signIn = useCallback((t: string) => {
    tokenStore.set(t);
    setToken(t);
  }, []);
  const signOut = useCallback(async () => {
    const res = await api.logout().catch(() => undefined);
    tokenStore.set(null);
    setToken(null);
    qc.clear();
    // End the Keycloak session too, or the next "Continue with SSO" would sign the same person in silently.
    if (res?.redirect) window.location.assign(res.redirect);
  }, [qc]);
  const switchOrg = useCallback(
    (slug: string) => {
      orgStore.set(slug);
      qc.clear();
      setOrgKey(slug);
    },
    [qc],
  );

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
      isAdmin: me.data?.role === 'admin' && !!me.data.organization,
      isSuperadmin: !!me.data?.superadmin,
      org: me.data?.organization ?? null,
      signIn,
      signOut,
      switchOrg,
    }),
    [token, me.data, me.isPending, signIn, signOut, switchOrg],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
