import { z } from 'zod';

export const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const idParam = z.object({ id: z.string().min(1).max(200) });
export const bpParam = z.object({ bp: z.string().min(1).max(64) });
export const entityParam = bpParam.extend({ id: z.string().min(1).max(200) });

/** `?filter.language=go&filter.tier=1` → { language: 'go', tier: '1' } */
export function filtersOf(query: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (k.startsWith('filter.') && typeof v === 'string') out[k.slice(7)] = v;
  return out;
}
