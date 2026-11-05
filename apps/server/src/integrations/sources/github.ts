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
  validate: (c) => requireFields(c, ['org', 'token'], 'github'),
  async *list(kind, { config, log }) {
    const api = str(config.apiUrl || 'https://api.github.com').replace(/\/$/, '');
    const org = encodeURIComponent(str(config.org));
    const headers = { authorization: `Bearer ${str(config.token)}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    let url: string | undefined;
    if (kind === 'repository') url = `${api}/orgs/${org}/repos?per_page=100&type=all`;
    else if (kind === 'team') url = `${api}/orgs/${org}/teams?per_page=100`;
    else if (kind === 'pull-request') url = `${api}/search/issues?per_page=100&q=${encodeURIComponent(`is:pr is:open org:${config.org}`)}`;
    else throw new Error(`github: unknown kind "${kind}"`);
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: Awaited<ReturnType<typeof http<unknown>>> = await http<unknown>(url, { headers });
      const items = kind === 'pull-request' ? ((res.data as { items?: unknown[] }).items ?? []) : (res.data as unknown[]);
      if (page === 0) log(`${kind}: fetching from ${new URL(url).pathname}`);
      yield items;
      url = nextLink(res.headers);
    }
  },
};
