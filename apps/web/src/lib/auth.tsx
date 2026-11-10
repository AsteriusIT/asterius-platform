import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgRef, PublicUser } from '@asterius/shared';
import { api, ApiError, orgStore, setUnauthorizedHandler, tabOrg, tokenStore } from './api';
import { hardNavigate, orgPath, urlOrg } from './orgUrl';

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
  /** Work in another organization: the app reloads at `/o/<slug><path>` (default: its home). */
  switchOrg: (slug: string, path?: string) => void;
  /** Slug of the tab's URL organization when the user may not enter it (not a member, or no such organization). */
  notMember: string | null;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState(tokenStore.get());
  // The tab's organization is fixed for its lifetime (from its URL): switching organizations reloads the app.
  const [orgKey] = useState(tabOrg);
  const me = useQuery({ queryKey: ['me', token, orgKey], queryFn: api.me, enabled: !!token, retry: false, staleTime: 60_000 });
  // The URL names an organization the user may not enter: load the account without it to list theirs.
  const urlSlug = urlOrg();
  const denied = !!urlSlug && me.error instanceof ApiError && me.error.status === 403;
  const outside = useQuery({ queryKey: ['me', token, null], queryFn: api.meOutsideOrg, enabled: !!token && denied, retry: false, staleTime: 60_000 });

  // Remember the organization the server settled on (first sign-in, the last tab used…) as the default for new visits.
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
    (slug: string, path = '/') => {
      orgStore.set(slug);
      qc.clear();
      hardNavigate(orgPath(slug, path), false);
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
      user: token ? (me.data ?? (denied ? (outside.data ?? null) : null)) : null,
      loading: !!token && (me.isPending || (denied && outside.isPending)),
      isAdmin: me.data?.role === 'admin' && !!me.data.organization,
      isSuperadmin: !!(me.data ?? outside.data)?.superadmin,
      org: me.data?.organization ?? null,
      signIn,
      signOut,
      switchOrg,
      notMember: denied && outside.data ? urlSlug : null,
    }),
    [token, me.data, me.isPending, denied, outside.data, outside.isPending, urlSlug, signIn, signOut, switchOrg],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
