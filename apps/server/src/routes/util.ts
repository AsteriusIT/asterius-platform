import { z } from 'zod';

export const MAX_OFFSET = 10_000;

export const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  /** Deep offsets scan and discard rows: beyond MAX_OFFSET use cursor pagination. */
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET, `offset is capped at ${MAX_OFFSET}; use the cursor`).default(0),
});

export const idParam = z.object({ id: z.string().min(1).max(200) });
export const bpParam = z.object({ bp: z.string().min(1).max(64) });
export const entityParam = bpParam.extend({ id: z.string().min(1).max(200) });
