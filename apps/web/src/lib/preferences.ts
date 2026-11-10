import { useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { UserPreferences } from '@asterius/shared';
import { api } from './api';
import { useAuth } from './auth';
import { notifyError } from './queryClient';

/**
 * Per-user preferences kept on the server (per organization): favourite actions, recent actions and catalog columns.
 * They follow the user across devices. Form drafts are not here: see drafts.ts.
 */

export const PREFS_KEY = ['preferences'] as const;
const RECENT_MAX = 5;
const IDENT_MAX = 200;
const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;
export const columnsKey = (bp: string) => `catalog.columns.${bp}` as const;

// ---------- one-time import of the values the browser kept before preferences moved to the server ----------
const LEGACY_FAV = 'asterius.favourites';
const LEGACY_RECENT = 'asterius.recent-actions';
const LEGACY_COLS = 'asterius.catalog.columns.';
const LEGACY_VIEWS = 'asterius.catalog.views.';

const strings = (v: unknown, max: number, len = IDENT_MAX) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= len))].slice(0, max) : [];

function legacyKeys(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k === LEGACY_FAV || k === LEGACY_RECENT || k.startsWith(LEGACY_COLS) || k.startsWith(LEGACY_VIEWS))) out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}
const readJson = (k: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? 'null');
  } catch {
    return null;
  }
};

/**
 * Moves favourites, recent actions, chosen columns and saved views from localStorage to the server once, then removes
 * them from the browser. Server values win for columns; favourites and recents are merged. If saving fails the
 * browser copy is kept and the import is retried on the next load.
 */
export async function importLegacyPreferences(server: UserPreferences, qc?: QueryClient): Promise<UserPreferences> {
  const keys = legacyKeys();
  if (!keys.length) return server;
  const patch: Record<string, unknown> = {};
  const fav = strings(readJson(LEGACY_FAV), 200);
  if (fav.length) patch.favourites = [...new Set([...(server.favourites ?? []), ...fav])].slice(0, 200);
  const recent = strings(readJson(LEGACY_RECENT), RECENT_MAX);
  if (recent.length) patch.recentActions = [...new Set([...(server.recentActions ?? []), ...recent])].slice(0, RECENT_MAX);
  const views: { name: string; blueprint: string; query: string }[] = [];
  for (const k of keys) {
    if (k.startsWith(LEGACY_COLS)) {
      const bp = k.slice(LEGACY_COLS.length);
      const cols = strings(readJson(k), 100, 64);
      if (SLUG.test(bp) && cols.length && !server[columnsKey(bp)]) patch[columnsKey(bp)] = cols;
    } else if (k.startsWith(LEGACY_VIEWS)) {
      const bp = k.slice(LEGACY_VIEWS.length);
      const list = readJson(k);
      if (SLUG.test(bp) && Array.isArray(list))
        for (const v of list as { name?: unknown; search?: unknown }[])
          if (typeof v?.name === 'string' && v.name.trim() && typeof v.search === 'string')
            views.push({ name: v.name.trim().slice(0, 100), blueprint: bp, query: v.search.slice(0, 2000) });
    }
  }
  let next = server;
  try {
    if (Object.keys(patch).length) next = await api.updatePreferences(patch);
    // A view with the same name already on the server (409) was imported before: skip it.
    for (const v of views) await api.createView(v).catch((e: { status?: number }) => (e?.status === 409 ? null : Promise.reject(e)));
  } catch {
    return next;
  }
  try {
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* private mode */
  }
  if (views.length) void qc?.invalidateQueries({ queryKey: ['views'] });
  return next;
}

/** The signed-in user's preferences, with optimistic updates (the UI never waits for the server to save). */
export function usePreferences() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: PREFS_KEY,
    queryFn: async () => importLegacyPreferences(await api.preferences(), qc),
    enabled: !!user,
    staleTime: 5 * 60_000,
  });
  const prefs: UserPreferences = q.data ?? {};

  const update = useCallback(
    (patch: Record<string, unknown>) => {
      qc.setQueryData<UserPreferences>(PREFS_KEY, (old) => {
        const out: Record<string, unknown> = { ...(old ?? {}) };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete out[k];
          else out[k] = v;
        }
        return out as UserPreferences;
      });
      api.updatePreferences(patch).catch((e: unknown) => {
        notifyError(e, 'Could not save your preferences');
        void qc.invalidateQueries({ queryKey: PREFS_KEY });
      });
    },
    [qc],
  );

  const current = () => qc.getQueryData<UserPreferences>(PREFS_KEY) ?? {};
  const toggleFavourite = (id: string) => {
    const cur = current().favourites ?? [];
    update({ favourites: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  const pushRecent = (id: string) => update({ recentActions: [id, ...(current().recentActions ?? []).filter((x) => x !== id)].slice(0, RECENT_MAX) });

  return {
    prefs,
    loaded: q.isSuccess,
    favourites: prefs.favourites ?? [],
    recent: prefs.recentActions ?? [],
    update,
    toggleFavourite,
    pushRecent,
  };
}
