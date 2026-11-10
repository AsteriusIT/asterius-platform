/**
 * Form drafts of self-service actions, kept in this browser on purpose: they are per device and may hold half-typed
 * (possibly sensitive) values that should not be sent to the server before the user submits them. Favourite and
 * recent actions are server-side preferences (preferences.ts).
 */

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

const draftKey = (action: string, entity: string | null) => `asterius.draft.${action}.${entity ?? ''}`;
export const loadDraft = (action: string, entity: string | null) => read<Record<string, unknown> | null>(draftKey(action, entity), null);
export const saveDraft = (action: string, entity: string | null, values: Record<string, unknown>) => write(draftKey(action, entity), values);
export const clearDraft = (action: string, entity: string | null) => write(draftKey(action, entity), null);

/** `?inputs=` accepts a JSON object; anything else is ignored. */
export function parseInputsParam(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
