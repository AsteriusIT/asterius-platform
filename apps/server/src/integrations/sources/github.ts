import { validateAuth } from '../../lib/auth.js';
import { http, nextLink } from '../../lib/http.js';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

/** GitHub (cloud or Enterprise Server): repositories, open pull requests and teams of an organization. */
export const githubSource: Source = {
  info: {
    type: 'github',
    title: 'GitHub',
    description: 'Repositories, open pull requests and teams of an organization.',
    kinds: ['repository', 'pull-request', 'team'],
    fields: [
      { key: 'org', label: 'Organization', kind: 'text', required: true, placeholder: 'my-org' },
      { key: 'token', label: 'Token', kind: 'secret', required: true, help: 'Fine-grained or classic token that can read the organization' },
      {
        key: 'apiUrl',
        label: 'API URL',
        kind: 'text',
        placeholder: 'https://api.github.com',
        help: 'GitHub Enterprise Server: https://<host>/api/v3',
        advanced: true,
      },
    ],
    example: {
      type: 'github',
      config: { org: 'my-org', token: '${secret:GITHUB_TOKEN}' },
      mappings: [
        {
          kind: 'repository',
          filter: 'archived = false',
          entity: {
            blueprint: 'repository',
            identifier: 'name',
            title: 'name',
            properties: { url: 'html_url', language: 'language', defaultBranch: 'default_branch', visibility: 'visibility' },
          },
        },
      ],
    },
  },
  incremental: true,
  validate(c) {
    requireFields(c, c.auth ? ['org'] : ['org', 'token'], 'github');
    validateAuth(c.auth);
  },
  async *list(kind, { config, log, state, startedAt, setState, incomplete }) {
    const since = (state as { since?: string } | undefined)?.since;
    const api = str(config.apiUrl || 'https://api.github.com').replace(/\/$/, '');
    const org = encodeURIComponent(str(config.org));
    const headers = {
      ...(config.auth ? {} : { authorization: `Bearer ${str(config.token)}` }),
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
    let url: string | undefined;
    // Repositories sorted by last push: an incremental run stops at the first page holding older ones.
    if (kind === 'repository') url = `${api}/orgs/${org}/repos?per_page=100&type=all${since ? '&sort=pushed&direction=desc' : ''}`;
    else if (kind === 'team') url = `${api}/orgs/${org}/teams?per_page=100`;
    else if (kind === 'pull-request')
      url = `${api}/search/issues?per_page=100&q=${encodeURIComponent(`is:pr is:open org:${config.org}${since ? ` updated:>=${since}` : ''}`)}`;
    else throw new Error(`github: unknown kind "${kind}"`);
    let fetched = 0;
    let page = 0;
    for (; url && page < MAX_PAGES; page++) {
      const res: Awaited<ReturnType<typeof http<unknown>>> = await http<unknown>(url, { headers, auth: config.auth });
      let items = kind === 'pull-request' ? ((res.data as { items?: unknown[] }).items ?? []) : (res.data as unknown[]);
      if (page === 0) log(`${kind}: fetching from ${new URL(url).pathname}${since ? ` (changed since ${since})` : ''}`);
      if (kind === 'pull-request') {
        const body = res.data as { total_count?: number; incomplete_results?: boolean };
        fetched += items.length;
        // The search API serves at most 1000 results and may time out internally (incomplete_results).
        if (body.incomplete_results) incomplete('GitHub search returned incomplete results');
        else if ((body.total_count ?? 0) > fetched && !nextLink(res.headers)) incomplete(`GitHub search capped at ${fetched} of ${body.total_count} results`);
      }
      let last = false;
      if (kind === 'repository' && since) {
        const fresh = items.filter((r) => String((r as { pushed_at?: string }).pushed_at ?? '') >= since);
        last = fresh.length < items.length;
        items = fresh;
      }
      yield items;
      if (last) {
        url = undefined;
        break;
      }
      url = url && nextLink(res.headers, url);
    }
    if (url) incomplete(`stopped after ${MAX_PAGES} pages`);
    setState({ since: startedAt });
  },
};
