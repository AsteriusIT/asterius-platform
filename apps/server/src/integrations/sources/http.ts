import { parsePayload, type Format } from '../../lib/formats.js';
import { validateAuth } from '../../lib/auth.js';
import { http, nextLink, sameOriginUrl } from '../../lib/http.js';
import { evaluate } from '../../lib/expr.js';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

/**
 * Any JSON API: the generic way to ingest from a custom service or a third party without code.
 *   itemsPath   JSONata selecting the item array in the response (default: the response itself)
 *   pagination  none | link | next (JSONata `nextUrl`) | offset | page | cursor (see `Pagination`)
 *   format      json | csv | tsv | yaml | xml | auto (default: JSON when the server says so)
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
    const pagination = (config.pagination ?? {}) as Pagination;
    // Opt-in incremental mode: `incremental: { sinceParam: "updated_since", etag: true }`
    const inc = (config.incremental ?? {}) as { sinceParam?: string; etag?: boolean };
    const prev = (state ?? {}) as { since?: string; etag?: string };
    const format = (config.format ? str(config.format) : undefined) as Format | undefined;
    let url: string | undefined = str(config.url);
    if (inc.sinceParam && prev.since) url = withParam(url, inc.sinceParam, prev.since);
    let body = config.body;
    let etag: string | undefined;
    let fetched = 0;
    let page = 0;
    for (; url && page < MAX_PAGES; page++) {
      const headers = { ...((config.headers as Record<string, string>) ?? {}) };
      if (page === 0 && inc.etag && prev.etag) headers['if-none-match'] = prev.etag;
      const res: Awaited<ReturnType<typeof http>> = await http(url, { method: str(config.method || 'GET'), headers, body, auth: config.auth });
      if (res.status === 304) {
        log('not modified (ETag)');
        etag = prev.etag;
        url = undefined;
        break;
      }
      if (page === 0) etag = res.headers.get('etag') ?? undefined;
      const data = format ? parsePayload(res.text, format, res.headers.get('content-type') ?? '') : res.data;
      const v = config.itemsPath ? await evaluate(str(config.itemsPath), data) : data;
      const items = v == null ? [] : Array.isArray(v) ? v : [v];
      fetched += items.length;
      log(`page ${page + 1}: ${items.length} items`);
      yield items;
      const next = await nextPage(pagination, { url, body, data, headers: res.headers, page, items: items.length, fetched });
      url = next?.url;
      body = next?.body ?? body;
    }
    if (url) incomplete(`stopped after ${MAX_PAGES} pages`);
    if (inc.sinceParam || inc.etag) setState({ since: startedAt, ...(inc.etag && etag ? { etag } : {}) });
  },
};

interface Pagination {
  /** none | link | next | offset | page | cursor */
  type?: string;
  /** next: JSONata giving the next URL. */
  nextUrl?: string;
  /** offset | page | cursor: name of the query (or body) parameter. */
  param?: string;
  /** offset | page: page size. */
  pageSize?: number;
  /** page: first page number (default 1). */
  startAt?: number;
  /** offset | page: JSONata of the total number of items, a stop condition. */
  totalPath?: string;
  /** cursor: JSONata of the next cursor in the response (empty: last page). */
  cursorPath?: string;
  /** offset | page | cursor: send the parameter in the JSON body instead of the query string. */
  in?: 'query' | 'body';
}

const withParam = (url: string, name: string, value: string | number) => {
  const u = new URL(url);
  u.searchParams.set(name, String(value));
  return u.toString();
};

/** Compute the next request of a paginated listing, or undefined when it is over. Exported for tests. */
export async function nextPage(
  p: Pagination,
  c: { url: string; body: unknown; data: unknown; headers: Headers; page: number; items: number; fetched: number },
): Promise<{ url: string; body?: unknown } | undefined> {
  const set = (value: string | number) => {
    if (!p.param) throw new Error(`http: pagination "${p.type}" needs "param"`);
    if (p.in === 'body') return { url: c.url, body: { ...((c.body as object) ?? {}), [p.param]: value } };
    return { url: withParam(c.url, p.param, value) };
  };
  switch (p.type) {
    case 'link': {
      const next = nextLink(c.headers, c.url); // same-origin only: the configured auth headers go with every page
      return next ? { url: next } : undefined;
    }
    case 'next': {
      if (!p.nextUrl) return undefined;
      const next = await evaluate(p.nextUrl, c.data);
      return typeof next === 'string' && next ? { url: sameOriginUrl(next, c.url) } : undefined;
    }
    case 'offset':
    case 'page': {
      const size = p.pageSize ?? 0;
      if (!c.items || (size && c.items < size)) return undefined;
      if (p.totalPath) {
        const total = Number(await evaluate(p.totalPath, c.data));
        if (Number.isFinite(total) && c.fetched >= total) return undefined;
      }
      const n = c.page + 1;
      return set(p.type === 'offset' ? n * (size || c.items) : (p.startAt ?? 1) + n);
    }
    case 'cursor': {
      const cursor = p.cursorPath ? await evaluate(p.cursorPath, c.data) : undefined;
      return cursor === undefined || cursor === null || cursor === '' || cursor === false ? undefined : set(String(cursor));
    }
    default:
      return undefined;
  }
}

/**
 * GraphQL API: one query per kind, pages through `pageInfo { hasNextPage endCursor }`.
 *   query / variables   the document and its variables
 *   itemsPath           JSONata selecting the nodes in the response (e.g. `data.organization.repositories.nodes`)
 *   pageInfoPath        JSONata of the pageInfo object in the response
 *   cursorVariable      variable receiving `endCursor` (default `after`)
 */
export const graphqlSource: Source = {
  info: {
    type: 'graphql',
    title: 'GraphQL API',
    description: 'Run a GraphQL query and page through the results with pageInfo cursors.',
    kinds: ['item'],
    example: {
      type: 'graphql',
      config: {
        url: 'https://api.example.com/graphql',
        headers: { Authorization: 'Bearer ${secret:API_TOKEN}' },
        query:
          'query($after: String) { organization(login: "my-org") { repositories(first: 100, after: $after) { nodes { name url } pageInfo { hasNextPage endCursor } } } }',
        itemsPath: 'data.organization.repositories.nodes',
        pageInfoPath: 'data.organization.repositories.pageInfo',
      },
      mappings: [{ kind: 'item', entity: { blueprint: 'repository', identifier: 'name', properties: { url: 'url' } } }],
    },
  },
  validate(c) {
    requireFields(c, ['url', 'query'], 'graphql');
    validateAuth(c.auth);
  },
  async *list(_kind, { config, log, incomplete }) {
    const cursorVar = str(config.cursorVariable || 'after');
    const variables: Record<string, unknown> = { ...((config.variables as Record<string, unknown>) ?? {}) };
    let page = 0;
    let more = true;
    for (; more && page < MAX_PAGES; page++) {
      const res = await http<{ data?: unknown; errors?: Array<{ message?: string }> }>(str(config.url), {
        method: 'POST',
        headers: (config.headers as Record<string, string>) ?? {},
        body: { query: str(config.query), variables },
        auth: config.auth,
      });
      const errors = res.data?.errors;
      if (errors?.length)
        throw new Error(
          `graphql: ${errors
            .map((e) => e.message)
            .join('; ')
            .slice(0, 300)}`,
        );
      const v = config.itemsPath ? await evaluate(str(config.itemsPath), res.data) : res.data?.data;
      const items = v == null ? [] : Array.isArray(v) ? v : [v];
      log(`page ${page + 1}: ${items.length} items`);
      yield items;
      const info = config.pageInfoPath
        ? ((await evaluate(str(config.pageInfoPath), res.data)) as { hasNextPage?: boolean; endCursor?: string } | undefined)
        : undefined;
      more = !!info?.hasNextPage && !!info.endCursor;
      if (more) variables[cursorVar] = info!.endCursor;
    }
    if (more) incomplete(`stopped after ${MAX_PAGES} pages`);
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
      config: { secret: '${secret:INGEST_TOKEN}', preset: 'github' }, // github | gitlab | azure-devops | slack; sync: true answers with the stats
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
  validate(c) {
    if (!c.secret && c.allowUnauthenticated !== true)
      throw new Error(
        'webhook integrations need a `secret` (e.g. ${secret:INGEST_TOKEN}); set `allowUnauthenticated: true` only for endpoints that must accept anonymous calls',
      );
  },
};
