import { http } from '../../lib/http.js';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

const PR_PAGE = 100;

/**
 * Azure DevOps: projects, repositories, pipelines and active pull requests (one project or the whole organization), and
 * the latest completed runs (`build`) of one pipeline with their tags (e.g. the V2 drift pipeline's `drift:yes`).
 */
export const azureDevOpsSource: Source = {
  info: {
    type: 'azure-devops',
    title: 'Azure DevOps',
    description: 'Projects, Git repositories, pipelines, active pull requests, and the latest runs of a pipeline (build, with tags).',
    kinds: ['project', 'repository', 'pipeline', 'pull-request', 'build'],
    fields: [
      { key: 'organization', label: 'Organization URL', kind: 'text', required: true, placeholder: 'https://dev.azure.com/my-org' },
      { key: 'project', label: 'Project', kind: 'text', placeholder: 'Platform', help: 'Empty: the whole organization (pipelines: of every project)' },
      { key: 'token', label: 'Personal access token', kind: 'secret', required: true, help: 'Read access to Code, Build and Project' },
      {
        key: 'pipeline',
        label: 'Pipeline (builds)',
        kind: 'text',
        placeholder: 'nightly-drift',
        help: 'kind build: pipeline name or id (needs project)',
        advanced: true,
      },
      { key: 'buildsTop', label: 'Runs to read (builds)', kind: 'number', placeholder: '50', advanced: true },
    ],
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
    if (kind === 'build') {
      yield await latestBuilds(org, config, headers, log);
      return;
    }
    const base = paths[kind];
    if (!base) throw new Error(`azure-devops: unknown kind "${kind}"`);
    if (kind === 'pipeline' && !project) {
      // Pipelines are listed per project: walk every project of the organization (one project per service in V2).
      let n = 0;
      for await (const projects of pages(`${org}/_apis/projects?$top=500&api-version=7.1`, headers, 'project', incomplete))
        for (const p of projects as { id: string; name: string }[]) {
          const url = `${org}/${encodeURIComponent(p.name)}/_apis/pipelines?$top=500&api-version=7.1`;
          for await (const items of pages(url, headers, 'pipeline', incomplete)) {
            n += items.length;
            yield items.map((i) => ({ ...(i as object), project: { id: p.id, name: p.name } }));
          }
        }
      log(`pipeline: ${n} items across the organization's projects`);
      return;
    }
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

/** Continuation-token pages of one listing (projects, pipelines). */
async function* pages(base: string, headers: Record<string, string>, kind: string, incomplete: (reason: string) => void) {
  let continuation: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url: string = continuation ? `${base}&continuationToken=${encodeURIComponent(continuation)}` : base;
    const res = await http<{ value: unknown[] }>(url, { headers });
    yield res.data.value ?? [];
    continuation = res.headers.get('x-ms-continuationtoken');
    if (!continuation) return;
  }
  incomplete(`${kind}: stopped after ${MAX_PAGES} pages`);
}

/**
 * kind `build`: the latest completed runs of one pipeline (`config.pipeline`, a name or an id, in `config.project`),
 * oldest first, so that when several runs report on the same entity the newest one is written last. Each item is a
 * Build (`id`, `buildNumber`, `result`, `finishTime`, `tags`, `_links.web.href`…) plus `project: { name }`.
 */
async function latestBuilds(org: string, config: Record<string, unknown>, headers: Record<string, string>, log: (m: string) => void) {
  const project = str(config.project);
  const pipeline = str(config.pipeline).trim();
  if (!project || !pipeline) throw new Error('azure-devops: kind "build" needs config.project and config.pipeline');
  const base = `${org}/${encodeURIComponent(project)}/_apis/build`;
  let id = /^\d+$/.test(pipeline) ? Number(pipeline) : undefined;
  if (id === undefined) {
    const defs = await http<{ value?: { id: number; name: string }[] }>(`${base}/definitions?name=${encodeURIComponent(pipeline)}&api-version=7.1`, {
      headers,
    });
    const found = (defs.data.value ?? []).filter((d) => d.name.toLowerCase() === pipeline.toLowerCase());
    if (found.length !== 1) throw new Error(`azure-devops: ${found.length ? 'several pipelines' : 'no pipeline'} named "${pipeline}" in ${project}`);
    id = found[0]!.id;
  }
  const top = Math.min(Math.max(Number(config.buildsTop ?? 50) || 50, 1), 500);
  const res = await http<{ value?: { finishTime?: string }[] }>(
    `${base}/builds?definitions=${id}&statusFilter=completed&queryOrder=finishTimeDescending&$top=${top}&api-version=7.1`,
    { headers },
  );
  const builds = (res.data.value ?? []).map((b) => ({ ...b, project: { name: project } }));
  log(`build: ${builds.length} completed run(s) of ${pipeline} (${id})`);
  return builds.sort((a, b) => Date.parse(a.finishTime ?? '') - Date.parse(b.finishTime ?? ''));
}
