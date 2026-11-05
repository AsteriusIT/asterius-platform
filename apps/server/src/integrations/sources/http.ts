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
        itemsPath: 'data',
        pagination: { type: 'next', nextUrl: 'links.next' },
      },
      mappings: [{ kind: 'item', entity: { blueprint: 'system', identifier: 'code', title: 'name', properties: { criticality: 'tier' } } }],
    },
  },
  validate: (c) => requireFields(c, ['url'], 'http'),
  async *list(_kind, { config, log }) {
    const pagination = (config.pagination ?? {}) as { type?: string; nextUrl?: string };
    let url: string | undefined = str(config.url);
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: Awaited<ReturnType<typeof http>> = await http(url, {
        method: str(config.method || 'GET'),
        headers: (config.headers as Record<string, string>) ?? {},
        body: config.body,
      });
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
