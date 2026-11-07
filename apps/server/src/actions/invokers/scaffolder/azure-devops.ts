import { http, UpstreamError } from '../../../lib/http.js';
import { guardedDownload } from '../../../lib/netguard.js';
import { str } from '../../types.js';
import { adoAuth, adoOrg } from '../ado.js';
import type { ScaffoldConfig } from './config.js';
import { checkLimits, MAX_FILE_BYTES, prefix, underPrefix, unsupportedMode } from './render.js';
import type { PublishContext, PublishResult, ScaffoldPublisher, TemplateFile } from './types.js';

const API = 'api-version=7.1';
const ZERO = '0000000000000000000000000000000000000000';

function need(c: ScaffoldConfig) {
  if (!c.organization || !c.project) throw new Error('scaffolder: azure-devops requires "organization" (URL) and "project"');
}
const headers = (c: ScaffoldConfig) => adoAuth(c);
/** `<org>/<project>/_apis/git/repositories/<repo>`; a repo written `project/repo` overrides the project. */
function repoUrl(c: ScaffoldConfig, name: string) {
  const [project, repo] = name.includes('/') ? (name.split('/') as [string, string]) : [str(c.project), name];
  return `${adoOrg(c)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
}
const refName = (b: string) => (b.startsWith('refs/') ? b : `refs/heads/${b}`);

/** Version descriptor query for a branch, tag (refs/tags/…) or commit sha; empty = default branch. */
function version(ref: string | undefined) {
  if (!ref || ref === 'HEAD') return '';
  const type = /^[0-9a-f]{40}$/i.test(ref) ? 'commit' : ref.startsWith('refs/tags/') ? 'tag' : 'branch';
  const v = ref.replace(/^refs\/(heads|tags)\//, '');
  return `&versionDescriptor.versionType=${type}&versionDescriptor.version=${encodeURIComponent(v)}`;
}

async function readTemplate(c: ScaffoldConfig): Promise<TemplateFile[]> {
  need(c);
  const url = repoUrl(c, c.templateRepo);
  const pre = prefix(c.templatePath);
  const list = await http<{ value: Array<{ objectId: string; gitObjectType: string; path: string; size?: number }> }>(
    `${url}/items?recursionLevel=Full&scopePath=${encodeURIComponent(`/${pre}`)}${version(c.templateRef)}&${API}`,
    { headers: headers(c) },
  );
  const blobs = (list.data.value ?? [])
    .filter((e) => e.gitObjectType === 'blob')
    .map((e) => ({ ...e, path: e.path.replace(/^\/+/, '') }))
    .filter((e) => underPrefix(e.path, pre));
  checkLimits(blobs.map((b) => b.size ?? 0));
  const out: TemplateFile[] = [];
  for (const b of blobs) {
    const res = await guardedDownload(`${url}/blobs/${b.objectId}?$format=octetstream&download=true&${API}`, { headers: headers(c) });
    if (!res.ok) throw new Error(`azure-devops: cannot read template file ${b.path} (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) throw new Error(`template file ${b.path} is larger than ${MAX_FILE_BYTES} bytes`);
    out.push({ path: pre ? b.path.slice(pre.length + 1) : b.path, content: buf.toString('base64') });
  }
  return out;
}

const notFound = (e: unknown) => e instanceof UpstreamError && e.status === 404;

/** Current tip of a branch, or null when it does not exist. */
async function branchTip(c: ScaffoldConfig, url: string, branch: string): Promise<string | null> {
  const res = await http<{ value: Array<{ name: string; objectId: string }> }>(`${url}/refs?filter=${encodeURIComponent(`heads/${branch}`)}&${API}`, {
    headers: headers(c),
  });
  return res.data.value?.find((r) => r.name === `refs/heads/${branch}`)?.objectId ?? null;
}

/** One commit holding all files (`add`, or `edit` for files that already exist on the branch) pushed on `branch`. */
async function pushFiles(
  c: ScaffoldConfig,
  url: string,
  ctx: Pick<PublishContext, 'files' | 'title'>,
  branch: string,
  oldObjectId: string,
  branchExists: boolean,
) {
  const changes = [];
  for (const f of ctx.files) {
    let exists = false;
    if (branchExists) {
      const found = await http(`${url}/items?path=${encodeURIComponent(`/${f.path}`)}${version(branch)}&${API}`, { headers: headers(c) }).catch((e) => {
        if (notFound(e)) return undefined;
        throw e;
      });
      exists = !!found;
    }
    changes.push({
      changeType: exists ? 'edit' : 'add',
      item: { path: `/${f.path}` },
      newContent: { content: f.content, contentType: 'base64encoded' },
    });
  }
  const push = await http<{ commits?: Array<{ commitId: string }>; refUpdates?: Array<{ newObjectId?: string }> }>(`${url}/pushes?${API}`, {
    method: 'POST',
    headers: headers(c),
    body: { refUpdates: [{ name: refName(branch), oldObjectId }], commits: [{ comment: ctx.title, changes }] },
  });
  return push.data.commits?.[0]?.commitId ?? push.data.refUpdates?.[0]?.newObjectId ?? '';
}

const reviewerIds = (c: ScaffoldConfig) =>
  (Array.isArray(c.reviewers) ? c.reviewers : (c.reviewers ?? '').split(','))
    .map((r) => r.trim())
    .filter(Boolean)
    .map((id) => ({ id }));

/** mode: pull-request — branch from the base branch (or continue an existing one), one push, then a PR (reused when active). */
async function pullRequest({ config: c, files, branch, title, body }: PublishContext): Promise<PublishResult> {
  need(c);
  const url = repoUrl(c, c.repo);
  const base = str(c.baseBranch || 'main');
  let tip = await branchTip(c, url, branch);
  const existed = tip !== null;
  if (!tip) {
    const baseTip = await branchTip(c, url, base);
    if (!baseTip) throw new Error(`azure-devops: base branch "${base}" not found in ${c.repo}`);
    await http(`${url}/refs?${API}`, { method: 'POST', headers: headers(c), body: [{ name: refName(branch), oldObjectId: ZERO, newObjectId: baseTip }] });
    tip = baseTip;
  }
  const commit = await pushFiles(c, url, { files, title }, branch, tip, existed);
  const active = await http<{ value: Array<{ pullRequestId: number; repository?: { webUrl?: string } }> }>(
    `${url}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(refName(branch))}&searchCriteria.targetRefName=${encodeURIComponent(refName(base))}&searchCriteria.status=active&${API}`,
    { headers: headers(c) },
  );
  let pr = active.data.value?.[0];
  if (!pr) {
    const reviewers = reviewerIds(c);
    const created = await http<{ pullRequestId: number; repository?: { webUrl?: string } }>(`${url}/pullrequests?${API}`, {
      method: 'POST',
      headers: headers(c),
      body: {
        sourceRefName: refName(branch),
        targetRefName: refName(base),
        title,
        description: c.description ?? body,
        ...(reviewers.length ? { reviewers } : {}),
      },
    });
    pr = created.data;
  }
  const repo = pr.repository?.webUrl ?? (await http<{ webUrl: string }>(`${url}?${API}`, { headers: headers(c) })).data.webUrl;
  return {
    repoUrl: repo,
    prUrl: `${repo}/pullrequest/${pr.pullRequestId}`,
    number: pr.pullRequestId,
    branch,
    commit,
    provider: 'azure-devops',
    files: files.map((f) => f.path),
  };
}

/** mode: new-repository — create the repository in the project and push the files to its default branch. */
async function newRepository({ config: c, files, title }: PublishContext): Promise<PublishResult> {
  need(c);
  const url = repoUrl(c, c.repo);
  const branch = str(c.defaultBranch || 'main');
  let repo = await http<{ webUrl: string; id: string }>(`${url}?${API}`, { headers: headers(c) }).then(
    (r) => r.data,
    (e) => {
      if (notFound(e)) return undefined;
      throw e;
    },
  );
  if (!repo) {
    const name = c.repo.includes('/') ? c.repo.split('/')[1]! : c.repo;
    repo = (
      await http<{ webUrl: string; id: string }>(`${adoOrg(c)}/${encodeURIComponent(str(c.project))}/_apis/git/repositories?${API}`, {
        method: 'POST',
        headers: headers(c),
        body: { name },
      })
    ).data;
  }
  const refs = await http<{ value: Array<{ name: string; objectId: string }> }>(`${url}/refs?${API}`, { headers: headers(c) });
  const all = refs.data.value ?? [];
  if (all.length && !c.reuseExisting)
    throw new Error(`azure-devops: repository ${c.repo} already exists and is not empty (set reuseExisting: true to push into it)`);
  const tip = all.find((r) => r.name === refName(branch))?.objectId ?? null;
  const commit = await pushFiles(c, url, { files, title: c.description ? `${title}\n\n${c.description}` : title }, branch, tip ?? ZERO, tip !== null);
  return { repoUrl: repo.webUrl, prUrl: null, branch, commit, provider: 'azure-devops', files: files.map((f) => f.path) };
}

export const azureDevopsPublisher: ScaffoldPublisher = {
  provider: 'azure-devops',
  modes: ['pull-request', 'new-repository'],
  readTemplate,
  async publish(ctx) {
    if (ctx.config.mode === 'pull-request') return pullRequest(ctx);
    if (ctx.config.mode === 'new-repository') return newRepository(ctx);
    throw unsupportedMode('azure-devops', ctx.config.mode);
  },
};
