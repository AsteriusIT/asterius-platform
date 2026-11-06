import { z } from 'zod';
import { validateAuth } from '../../lib/auth.js';
import { http } from '../../lib/http.js';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

/**
 * Out-of-process source: a service you run (any language) lists items over HTTP.
 *
 *   POST {url}/list   { kind, config, cursor, state, startedAt }
 *   →  200 { items: [...], nextCursor?: string, state?: any, incomplete?: string }
 *
 * `cursor` is absent on the first call and the previous `nextCursor` afterwards. `state` (optional) is the value
 * returned by the previous run, for incremental listings. `config` is the integration configuration without
 * `url`, `auth` and `headers`. Authenticate with `auth` / `headers` like the http source.
 */
const listResponse = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
  state: z.unknown().optional(),
  incomplete: z.string().nullish(),
});

export const externalSource: Source = {
  info: {
    type: 'external',
    title: 'External plugin (HTTP)',
    description: 'Delegate listing to your own service over a small HTTP contract (any language, isolated process).',
    kinds: ['item'],
    example: {
      type: 'external',
      config: { url: 'https://asterius-plugin-jira.internal', headers: { Authorization: 'Bearer ${secret:PLUGIN_TOKEN}' }, project: 'PLAT' },
      mappings: [{ kind: 'issue', entity: { blueprint: 'ticket', identifier: 'key', title: 'summary' } }],
    },
  },
  incremental: true,
  validate(c) {
    requireFields(c, ['url'], 'external');
    validateAuth(c.auth);
  },
  async *list(kind, { config, log, state, startedAt, setState, incomplete }) {
    const { url, headers, auth, ...rest } = config;
    let cursor: string | undefined;
    let next: unknown = undefined;
    let hasNext = true;
    for (let page = 0; hasNext && page < MAX_PAGES; page++) {
      const res = await http(`${str(url).replace(/\/$/, '')}/list`, {
        method: 'POST',
        headers: (headers as Record<string, string>) ?? {},
        auth,
        body: { kind, config: rest, cursor, state, startedAt },
      });
      const parsed = listResponse.safeParse(res.data);
      if (!parsed.success)
        throw new Error(`external: invalid /list response: ${parsed.error.issues[0]?.path.join('.') || 'body'} ${parsed.error.issues[0]?.message}`);
      const body = parsed.data;
      log(`page ${page + 1}: ${body.items.length} items`);
      yield body.items;
      if (body.incomplete) incomplete(body.incomplete);
      if (body.state !== undefined) next = body.state;
      cursor = body.nextCursor ?? undefined;
      hasNext = !!cursor;
    }
    if (hasNext) incomplete(`stopped after ${MAX_PAGES} pages`);
    if (next !== undefined) setState(next);
  },
};
