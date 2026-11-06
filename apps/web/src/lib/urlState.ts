import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/** Copy of `prev` with `key` set (or removed when empty). Any change but `page` resets paging. */
export function withParam(prev: URLSearchParams, key: string, value: string | null | undefined): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (value) next.set(key, value);
  else next.delete(key);
  if (key !== 'page') next.delete('page');
  return next;
}

/** Read the URL search params and get a stable setter that updates one of them in place (no history entry). */
export function useUrlParams() {
  const [params, setParams] = useSearchParams();
  const set = useCallback((key: string, value: string | null | undefined) => setParams((prev) => withParam(prev, key, value), { replace: true }), [setParams]);
  return [params, set, setParams] as const;
}
