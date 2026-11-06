import { parse as parseYaml } from 'yaml';
import { validateAuth } from '../../lib/auth.js';
import { http, nextLink, UpstreamError } from '../../lib/http.js';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

/**
 * Descriptor files committed next to the code (Backstage style): scans the repositories of a GitHub organization,
 * a GitLab group or an Azure DevOps project for `path` (default `asterius.yaml`) and yields one item per document:
 *
 *   { repository: { name, fullName, url, defaultBranch }, descriptor: <parsed YAML>, path }
 *
 * A descriptor may also list several components under `entities:`, in which case each is yielded separately with
 * `entity` set. Mappings (kind `descriptor`) then write the catalog entities; the repository is the source of truth,
 * so with `deleteMissing` removing the file removes the entity. Invalid YAML is skipped with a log line.
 * The JSON Schema for editors is served at /api/descriptor-schema.json.
 */

interface Repo {
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  /** Provider-specific locator. */
  ref: string;
}

const CONCURRENCY = 5;
const MAX_FILE_BYTES = 256 * 1024;

type Lister = (config: Record<string, unknown>, log: (l: string) => void) => AsyncGenerator<Repo[]>;
type Fetcher = (config: Record<string, unknown>, repo: Repo, path: string) => Promise<string | undefined>;

const clip = (text: string) => (text.length > MAX_FILE_BYTES ? undefined : text);
const notFound = (err: unknown) => err instanceof UpstreamError && (err.status === 404 || err.status === 403 || err.status === 409);

const github: { list: Lister; fetch: Fetcher } = {
  async *list(c) {
    const api = str(c.apiUrl || 'https://api.github.com').replace(/\/$/, '');
    let url: string | undefined = `${api}/orgs/${encodeURIComponent(str(c.org))}/repos?per_page=100&type=all`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: Awaited<ReturnType<typeof http<Array<Record<string, unknown>>>>> = await http(url, { headers: ghHeaders(c), auth: c.auth });
      yield res.data
        .filter((r) => !r.archived)
        .map((r) => ({ name: str(r.name), fullName: str(r.full_name), url: str(r.html_url), defaultBranch: str(r.default_branch), ref: str(r.full_name) }));
      url = nextLink(res.headers);
    }
  },
  async fetch(c, repo, path) {
    const api = str(c.apiUrl || 'https://api.github.com').replace(/\/$/, '');
    try {
      const res = await http<string>(
        `${api}/repos/${repo.ref}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(repo.defaultBranch)}`,
        {
          headers: { ...ghHeaders(c), accept: 'application/vnd.github.raw+json' },
          auth: c.auth,
        },
      );
      return clip(res.text);
    } catch (err) {
      if (notFound(err)) return undefined;
      throw err;
    }
  },
};
const ghHeaders = (c: Record<string, unknown>) => ({ ...(c.auth ? {} : { authorization: `Bearer ${str(c.token)}` }), 'x-github-api-version': '2022-11-28' });

const gitlab: { list: Lister; fetch: Fetcher } = {
  async *list(c) {
    const base = str(c.baseUrl || 'https://gitlab.com').replace(/\/$/, '');
    let url: string | undefined = `${base}/api/v4/groups/${encodeURIComponent(str(c.group))}/projects?include_subgroups=true&archived=false&per_page=100`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: Awaited<ReturnType<typeof http<Array<Record<string, unknown>>>>> = await http(url, { headers: { 'private-token': str(c.token) } });
      yield res.data.map((r) => ({
        name: str(r.name),
        fullName: str(r.path_with_namespace),
        url: str(r.web_url),
        defaultBranch: str(r.default_branch || 'main'),
        ref: str(r.id),
      }));
      url = nextLink(res.headers);
    }
  },
  async fetch(c, repo, path) {
    const base = str(c.baseUrl || 'https://gitlab.com').replace(/\/$/, '');
    try {
      const res = await http<string>(
        `${base}/api/v4/projects/${encodeURIComponent(repo.ref)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(repo.defaultBranch)}`,
        {
          headers: { 'private-token': str(c.token) },
        },
      );
      return clip(res.text);
    } catch (err) {
      if (notFound(err)) return undefined;
      throw err;
    }
  },
};

const adoHeaders = (c: Record<string, unknown>) => {
  const t = str(c.token);
  return { authorization: t.startsWith('Bearer ') ? t : `Basic ${Buffer.from(`:${t}`).toString('base64')}` };
};
const azure: { list: Lister; fetch: Fetcher } = {
  async *list(c) {
    const org = str(c.organization).replace(/\/$/, '');
    const project = c.project ? `/${encodeURIComponent(str(c.project))}` : '';
    const res = await http<{ value: Array<Record<string, unknown>> }>(`${org}${project}/_apis/git/repositories?api-version=7.1`, { headers: adoHeaders(c) });
    yield (res.data.value ?? [])
      .filter((r) => !r.isDisabled)
      .map((r) => ({
        name: str(r.name),
        fullName: `${str((r.project as { name?: string } | undefined)?.name)}/${str(r.name)}`,
        url: str(r.webUrl),
        defaultBranch: str(r.defaultBranch).replace(/^refs\/heads\//, '') || 'main',
        ref: `${str((r.project as { id?: string } | undefined)?.id)}/${str(r.id)}`,
      }));
  },
  async fetch(c, repo, path) {
    const org = str(c.organization).replace(/\/$/, '');
    const [project, id] = repo.ref.split('/');
    try {
      const res = await http<string>(
        `${org}/${project}/_apis/git/repositories/${id}/items?path=${encodeURIComponent(`/${path}`)}&versionDescriptor.version=${encodeURIComponent(repo.defaultBranch)}&includeContent=true&$format=text&api-version=7.1`,
        { headers: { ...adoHeaders(c), accept: 'text/plain' } },
      );
      return clip(res.text);
    } catch (err) {
      if (notFound(err)) return undefined;
      throw err;
    }
  },
};

const PROVIDERS = { github, gitlab, 'azure-devops': azure } as const;

/**
 * Repository (`fullName` as listed by the provider) of a push event of GitHub, GitLab or Azure DevOps; undefined for
 * events that cannot change a descriptor (other branches than the default one, non-push events).
 */
export function repositoryOfPush(payload: unknown, headers: Record<string, unknown> = {}): string | undefined {
  const p = (payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const event = String(headers['x-github-event'] ?? headers['x-gitlab-event'] ?? '');
  if (p.repository?.full_name && p.ref) {
    // GitHub push
    if (event && event !== 'push') return undefined;
    const def = p.repository.default_branch;
    return !def || p.ref === `refs/heads/${def}` ? String(p.repository.full_name) : undefined;
  }
  if (p.project?.path_with_namespace) {
    // GitLab push
    if (event && !/push/i.test(event)) return undefined;
    const def = p.project.default_branch;
    return !def || !p.ref || p.ref === `refs/heads/${def}` ? String(p.project.path_with_namespace) : undefined;
  }
  if (p.eventType === 'git.push' && p.resource?.repository) {
    // Azure DevOps service hook
    const repo = p.resource.repository;
    const def = String(repo.defaultBranch ?? '');
    const ref = String(p.resource.refUpdates?.[0]?.name ?? '');
    return !def || !ref || ref === def ? `${repo.project?.name}/${repo.name}` : undefined;
  }
  return undefined;
}

export const descriptorsSource: Source = {
  info: {
    type: 'git-descriptors',
    title: 'Repository descriptors',
    description: 'Discover asterius.yaml / catalog-info.yaml files committed in the repositories of a GitHub, GitLab or Azure DevOps scope.',
    kinds: ['descriptor'],
    example: {
      type: 'git-descriptors',
      config: {
        provider: 'github',
        org: 'my-org',
        token: '${secret:GITHUB_TOKEN}',
        path: 'asterius.yaml',
        pushSecret: '${secret:PUSH_WEBHOOK_SECRET}',
        pushPreset: 'github',
      }, // pushSecret: refresh a repository on push (POST /api/v1/ingest/<id>)
      mappings: [
        {
          kind: 'descriptor',
          entity: {
            blueprint: 'service',
            identifier: 'descriptor.name',
            title: 'descriptor.title',
            team: 'descriptor.owner',
            properties: { repository: 'repository.url', tier: 'descriptor.tier', lifecycle: 'descriptor.lifecycle' },
          },
        },
      ],
    },
  },
  validate(c) {
    const provider = str(c.provider) as keyof typeof PROVIDERS;
    if (!PROVIDERS[provider]) throw new Error(`git-descriptors: provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
    requireFields(c, provider === 'github' ? ['org'] : provider === 'gitlab' ? ['group', 'token'] : ['organization', 'token'], 'git-descriptors');
    if (provider === 'github' && !c.auth) requireFields(c, ['token'], 'git-descriptors');
    validateAuth(c.auth);
    const p = str(c.path || 'asterius.yaml');
    if (p.startsWith('/') || p.includes('..')) throw new Error('git-descriptors: path must be relative to the repository root');
  },
  pushScope(payload, headers) {
    return repositoryOfPush(payload, headers);
  },
  async *list(_kind, { config, log, incomplete, scope }) {
    const provider = PROVIDERS[str(config.provider) as keyof typeof PROVIDERS];
    const path = str(config.path || 'asterius.yaml');
    let scanned = 0;
    let found = 0;
    for await (let repos of provider.list(config, log)) {
      if (scope) repos = repos.filter((r) => r.fullName === scope);
      for (let i = 0; i < repos.length; i += CONCURRENCY) {
        const results = await Promise.all(
          repos.slice(i, i + CONCURRENCY).map(async (repo) => {
            const text = await provider.fetch(config, repo, path);
            if (text === undefined) return [];
            let doc: unknown;
            try {
              doc = parseYaml(text);
            } catch (err) {
              log(`${repo.fullName}: ${path} is not valid YAML (${(err as Error).message.split('\n')[0]})`);
              // The repository still exists and has a descriptor: do not let deleteMissing remove its entities.
              incomplete(`${repo.fullName}: invalid descriptor`);
              return [];
            }
            if (!doc || typeof doc !== 'object') return [];
            const { entities, ...rest } = doc as Record<string, unknown>;
            const repository = { name: repo.name, fullName: repo.fullName, url: repo.url, defaultBranch: repo.defaultBranch };
            if (Array.isArray(entities) && entities.length)
              return entities.map((entity) => ({ repository, path, descriptor: { ...rest, ...(entity as object) }, entity }));
            return [{ repository, path, descriptor: rest }];
          }),
        );
        scanned += Math.min(CONCURRENCY, repos.length - i);
        const items = results.flat();
        found += items.length;
        if (items.length) yield items;
      }
    }
    log(`${scanned} repositories scanned, ${found} descriptor(s) found`);
  },
};

/** JSON Schema of the descriptor, for editor validation (`# yaml-language-server: $schema=<host>/api/descriptor-schema.json`). */
export const DESCRIPTOR_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Asterius descriptor',
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Entity identifier (unique per blueprint).' },
    title: { type: 'string' },
    owner: { type: 'string', description: 'Identifier of the owning team.' },
    tier: { type: ['string', 'number'] },
    lifecycle: { type: 'string' },
    properties: { type: 'object', additionalProperties: true, description: 'Free properties, mapped by the integration.' },
    relations: { type: 'object', additionalProperties: { type: ['string', 'array'], items: { type: 'string' } } },
    entities: {
      type: 'array',
      description: 'Several components in one repository: each inherits the top-level fields.',
      items: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, title: { type: 'string' }, owner: { type: 'string' } },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};
