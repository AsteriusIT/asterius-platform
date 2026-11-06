import { validateAuth } from '../../lib/auth.js';
import { http, nextLink } from '../../lib/http.js';
import { evaluate } from '../../lib/expr.js';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

/**
 * Any JSON API: the generic way to ingest from a custom service or a third party without code.
 *   itemsPath   JSONata selecting the item array in the response (default: the response itself)
 *   pagination  none | link (RFC 5988 Link header) | next (JSONata `nextUrl` on the response body)
 */
export const httpSource: Source = {
  info: {
    type: 'http',
    title: 'HTTP / JSON API',
    description: 'Pull items from any JSON API, with optional pagination.',
    kinds: ['item'],
    example: {
      type: 'http',
      config: {
        url: 'https://cmdb.internal/api/applications',
        headers: { Authorization: 'Bearer ${secret:CMDB_TOKEN}' },
        // or: auth: { type: 'oauth2-client-credentials', tokenUrl: '…', clientId: '…', clientSecret: '${secret:X}' }
        itemsPath: 'data',
        pagination: { type: 'next', nextUrl: 'links.next' },
        // optional: incremental: { sinceParam: 'updated_since', etag: true },
      },
      mappings: [{ kind: 'item', entity: { blueprint: 'system', identifier: 'code', title: 'name', properties: { criticality: 'tier' } } }],
    },
  },
  incremental: true,
  validate(c) {
    requireFields(c, ['url'], 'http');
    validateAuth(c.auth);
  },
  async *list(_kind, { config, log, state, startedAt, setState, incomplete }) {
    const pagination = (config.pagination ?? {}) as { type?: string; nextUrl?: string };
    // Opt-in incremental mode: `incremental: { sinceParam: "updated_since", etag: true }`
    const inc = (config.incremental ?? {}) as { sinceParam?: string; etag?: boolean };
    const prev = (state ?? {}) as { since?: string; etag?: string };
    let url: string | undefined = str(config.url);
    if (inc.sinceParam && prev.since) {
      const u = new URL(url);
      u.searchParams.set(inc.sinceParam, prev.since);
      url = u.toString();
    }
    let etag: string | undefined;
    let page = 0;
    for (; url && page < MAX_PAGES; page++) {
      const headers = { ...((config.headers as Record<string, string>) ?? {}) };
      if (page === 0 && inc.etag && prev.etag) headers['if-none-match'] = prev.etag;
      const res: Awaited<ReturnType<typeof http>> = await http(url, { method: str(config.method || 'GET'), headers, body: config.body, auth: config.auth });
      if (res.status === 304) {
        log('not modified (ETag)');
        etag = prev.etag;
        url = undefined;
        break;
      }
      if (page === 0) etag = res.headers.get('etag') ?? undefined;
      const v = config.itemsPath ? await evaluate(str(config.itemsPath), res.data) : res.data;
      const items = v == null ? [] : Array.isArray(v) ? v : [v];
      log(`page ${page + 1}: ${items.length} items`);
      yield items;
      if (pagination.type === 'link') url = nextLink(res.headers);
      else if (pagination.type === 'next' && pagination.nextUrl) {
        const next = await evaluate(pagination.nextUrl, res.data);
        url = typeof next === 'string' && next ? new URL(next, url).toString() : undefined;
      } else url = undefined;
    }
    if (url) incomplete(`stopped after ${MAX_PAGES} pages`);
    if (inc.sinceParam || inc.etag) setState({ since: startedAt, ...(inc.etag && etag ? { etag } : {}) });
  },
};

/** Inbound webhooks: third parties POST events to /api/v1/ingest/<integration>; mappings run on each payload. */
export const webhookSource: Source = {
  info: {
    type: 'webhook',
    title: 'Inbound webhook',
    description: 'Receive events from any system (GitHub, ArgoCD, Jira, custom) and map them to entities.',
    kinds: ['event'],
    example: {
      type: 'webhook',
      config: { secret: '${secret:INGEST_TOKEN}', signatureHeader: 'x-hub-signature-256' },
      mappings: [
        {
          kind: 'event',
          filter: '$headers."x-github-event" = "deployment_status"',
          entity: {
            blueprint: 'deployment',
            identifier: 'repository.name & "-" & $string(deployment.id)',
            properties: { status: 'deployment_status.state', environment: 'deployment.environment', url: 'deployment_status.target_url' },
            relations: { repository: 'repository.name' },
          },
        },
      ],
    },
  },
  push: true,
  validate: () => undefined,
};
