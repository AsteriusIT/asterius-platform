import { config } from '../config.js';

export interface SecretProvider {
  kind: string;
  title: string;
  /** Is the provider configured on this deployment? */
  enabled(): boolean;
  /** Example reference shown in the admin UI. */
  example: string;
  /** Validate and fetch; `ref` is the text after `kind:`. */
  get(ref: string): Promise<string>;
}

/** Reference characters: provider paths only, no whitespace, no path traversal. */
export const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9_.:/#@+=-]{0,299}$/;
export function assertSafeRef(ref: string, what: string) {
  if (!SAFE_REF.test(ref) || ref.split('/').some((s) => s === '..' || s === '.')) throw new Error(`Invalid ${what} reference`);
}

export async function httpJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(config.HTTP_TIMEOUT_SECONDS * 1000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`); // the body may echo credentials: never include it
  return (await res.json()) as T;
}
