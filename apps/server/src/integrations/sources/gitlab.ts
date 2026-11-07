import { http, nextLink } from '../../lib/http.js';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

/** GitLab: projects and open merge requests of a group (subgroups included). */
export const gitlabSource: Source = {
  info: {
    type: 'gitlab',
    title: 'GitLab',
    description: 'Projects and open merge requests of a group, including subgroups.',
    kinds: ['project', 'merge-request'],
    fields: [
      { key: 'group', label: 'Group', kind: 'text', required: true, placeholder: 'my-group', help: 'Group path or id (subgroups included)' },
      { key: 'token', label: 'Token', kind: 'secret', required: true, help: 'Access token with read_api' },
      { key: 'baseUrl', label: 'Base URL', kind: 'text', placeholder: 'https://gitlab.com', help: 'Self-managed GitLab instance', advanced: true },
    ],
    example: {
      type: 'gitlab',
      config: { baseUrl: 'https://gitlab.com', group: 'my-group', token: '${secret:GITLAB_TOKEN}' },
      mappings: [
        {
          kind: 'project',
          filter: 'archived = false',
          entity: {
            blueprint: 'repository',
            identifier: 'path_with_namespace',
            title: 'name',
            properties: { url: 'web_url', defaultBranch: 'default_branch' },
          },
        },
      ],
    },
  },
  incremental: true,
  validate: (c) => requireFields(c, ['group', 'token'], 'gitlab'),
  async *list(kind, { config, log, state, startedAt, setState, incomplete }) {
    const since = (state as { since?: string } | undefined)?.since;
    const q = since ? `&${kind === 'project' ? 'last_activity_after' : 'updated_after'}=${encodeURIComponent(since)}` : '';
    const group = `${str(config.baseUrl || 'https://gitlab.com').replace(/\/$/, '')}/api/v4/groups/${encodeURIComponent(str(config.group))}`;
    let url: string | undefined;
    if (kind === 'project') url = `${group}/projects?include_subgroups=true&per_page=100${q}`;
    else if (kind === 'merge-request') url = `${group}/merge_requests?state=opened&per_page=100${q}`;
    else throw new Error(`gitlab: unknown kind "${kind}"`);
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: Awaited<ReturnType<typeof http<unknown[]>>> = await http<unknown[]>(url, { headers: { 'private-token': str(config.token) } });
      if (page === 0) log(`${kind}: fetching ${res.headers.get('x-total') ?? '?'} items`);
      yield res.data;
      url = url && nextLink(res.headers, url);
    }
    if (url) incomplete(`stopped after ${MAX_PAGES} pages`);
    setState({ since: startedAt });
  },
};
