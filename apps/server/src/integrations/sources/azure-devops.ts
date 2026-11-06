import { http } from '../../lib/http.js';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

const PR_PAGE = 100;

/** Azure DevOps: projects, repositories, pipelines and active pull requests (one project or the whole organization). */
export const azureDevOpsSource: Source = {
  info: {
    type: 'azure-devops',
    title: 'Azure DevOps',
    description: 'Projects, Git repositories, pipelines and active pull requests.',
    kinds: ['project', 'repository', 'pipeline', 'pull-request'],
    example: {
      type: 'azure-devops',
      config: { organization: 'https://dev.azure.com/my-org', project: 'Platform', token: '${secret:ADO_PAT}' },
      mappings: [
        {
          kind: 'repository',
          entity: {
            blueprint: 'repository',
            identifier: 'name',
            properties: { url: 'webUrl', defaultBranch: '$replace(defaultBranch, "refs/heads/", "")', project: 'project.name' },
          },
        },
      ],
    },
  },
  validate(c) {
    requireFields(c, ['organization', 'token'], 'azure-devops');
  },
  async *list(kind, { config, log, incomplete }) {
    const org = str(config.organization).replace(/\/$/, '');
    const project = config.project ? `/${encodeURIComponent(str(config.project))}` : '';
    const t = str(config.token);
    const headers = { authorization: t.startsWith('Bearer ') ? t : `Basic ${Buffer.from(`:${t}`).toString('base64')}` };
    const paths: Record<string, string> = {
      project: `${org}/_apis/projects?$top=500&api-version=7.1`,
      repository: `${org}${project}/_apis/git/repositories?api-version=7.1`,
      pipeline: `${org}${project}/_apis/pipelines?$top=500&api-version=7.1`,
      'pull-request': `${org}${project}/_apis/git/pullrequests?searchCriteria.status=active&$top=${PR_PAGE}&api-version=7.1`,
    };
    const base = paths[kind];
    if (!base) throw new Error(`azure-devops: unknown kind "${kind}"`);
    if (kind === 'pipeline' && !project) throw new Error('azure-devops: listing pipelines needs config.project');
    let continuation: string | null = null;
    let skip = 0;
    let more = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      // Pull requests page with $skip (the API silently caps $top); the others with a continuation token.
      const url: string = continuation
        ? `${base}&continuationToken=${encodeURIComponent(continuation)}`
        : kind === 'pull-request' && skip
          ? `${base}&$skip=${skip}`
          : base;
      const res = await http<{ value: unknown[] }>(url, { headers });
      const items = res.data.value ?? [];
      if (page === 0) log(`${kind}: ${items.length} items in the first page`);
      yield items;
      continuation = res.headers.get('x-ms-continuationtoken');
      skip += items.length;
      more = kind === 'pull-request' ? items.length >= PR_PAGE : !!continuation;
      if (!more) break;
    }
    if (more) incomplete(`stopped after ${MAX_PAGES} pages`);
  },
};
