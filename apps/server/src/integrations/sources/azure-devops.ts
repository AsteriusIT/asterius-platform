import { http } from '../../lib/http.js';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

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
  async *list(kind, { config, log }) {
    const org = str(config.organization).replace(/\/$/, '');
    const project = config.project ? `/${encodeURIComponent(str(config.project))}` : '';
    const t = str(config.token);
    const headers = { authorization: t.startsWith('Bearer ') ? t : `Basic ${Buffer.from(`:${t}`).toString('base64')}` };
    const paths: Record<string, string> = {
      project: `${org}/_apis/projects?$top=500&api-version=7.1`,
      repository: `${org}${project}/_apis/git/repositories?api-version=7.1`,
      pipeline: `${org}${project}/_apis/pipelines?$top=500&api-version=7.1`,
      'pull-request': `${org}${project}/_apis/git/pullrequests?searchCriteria.status=active&$top=1000&api-version=7.1`,
    };
    const base = paths[kind];
    if (!base) throw new Error(`azure-devops: unknown kind "${kind}"`);
    if (kind === 'pipeline' && !project) throw new Error('azure-devops: listing pipelines needs config.project');
    let continuation: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url: string = continuation ? `${base}&continuationToken=${encodeURIComponent(continuation)}` : base;
      const res = await http<{ value: unknown[] }>(url, { headers });
      if (page === 0) log(`${kind}: ${res.data.value?.length ?? 0} items in the first page`);
      yield res.data.value ?? [];
      continuation = res.headers.get('x-ms-continuationtoken');
      if (!continuation) break;
    }
  },
};
