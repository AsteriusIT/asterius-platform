import { http } from '../../../lib/http.js';
import { str } from '../../types.js';
import type { ScaffoldConfig } from './config.js';
import { checkLimits, prefix, underPrefix, unsupportedMode } from './render.js';
import type { PublishContext, PublishResult, ScaffoldPublisher, TemplateFile } from './types.js';

const api = (c: ScaffoldConfig) => str(c.apiUrl || c.baseUrl || 'https://api.github.com').replace(/\/$/, '');
const headers = (c: ScaffoldConfig) => ({
  authorization: `Bearer ${str(c.token)}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});

async function readTemplate(c: ScaffoldConfig): Promise<TemplateFile[]> {
  const repo = c.templateRepo;
  const ref = str(c.templateRef || 'HEAD');
  const pre = prefix(c.templatePath);
  const tree = await http<{ tree: Array<{ path: string; type: string; sha: string; size?: number }>; truncated?: boolean }>(
    `${api(c)}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers: headers(c) },
  );
  if (tree.data.truncated) throw new Error('template repository is too large');
  const blobs = tree.data.tree.filter((e) => e.type === 'blob' && underPrefix(e.path, pre));
  checkLimits(blobs.map((b) => b.size ?? 0));
  const out: TemplateFile[] = [];
  for (const b of blobs) {
    const blob = await http<{ content: string }>(`${api(c)}/repos/${repo}/git/blobs/${b.sha}`, { headers: headers(c) });
    out.push({ path: pre ? b.path.slice(pre.length + 1) : b.path, content: blob.data.content.replace(/\n/g, '') });
  }
  return out;
}

const enc = (s: string) => encodeURIComponent(s);
const notFound = (e: unknown) => (e as { status?: number })?.status === 404;
const status = (e: unknown) => (e as { status?: number })?.status;

/**
 * mode: pull-request — idempotent: the branch is created from the base branch only when missing (otherwise new commits
 * go on top of it), unchanged files are not rewritten, and an open PR for branch -> base is reused.
 */
async function pullRequest({ config: c, files, branch, title, body }: PublishContext): Promise<PublishResult> {
  const target = c.repo;
  const base = str(c.baseBranch || 'main');
  const ref = (name: string) =>
    http<{ object: { sha: string } }>(`${api(c)}/repos/${target}/git/ref/heads/${name.split('/').map(enc).join('/')}`, { headers: headers(c) });
  let commit: string;
  try {
    commit = (await ref(branch)).data.object.sha; // re-run: the branch exists
  } catch (e) {
    if (!notFound(e)) throw e;
    const baseRef = await ref(base);
    await http(`${api(c)}/repos/${target}/git/refs`, {
      method: 'POST',
      headers: headers(c),
      body: { ref: `refs/heads/${branch}`, sha: baseRef.data.object.sha },
    });
    commit = baseRef.data.object.sha;
  }
  for (const f of files) {
    const url = `${api(c)}/repos/${target}/contents/${f.path.split('/').map(enc).join('/')}`;
    // An existing file on the branch (template overwrites, re-runs) needs its sha; identical content is skipped.
    const existing = await http<{ sha?: string; content?: string }>(`${url}?ref=${enc(branch)}`, { headers: headers(c) }).catch(() => undefined);
    if (existing?.data.content && existing.data.content.replace(/\n/g, '') === f.content) continue;
    const put = await http<{ commit?: { sha?: string } }>(url, {
      method: 'PUT',
      headers: headers(c),
      body: { message: `scaffold: ${f.path}`, content: f.content, branch, ...(existing?.data.sha ? { sha: existing.data.sha } : {}) },
    });
    commit = put.data.commit?.sha ?? commit;
  }
  type Pull = { html_url: string; number: number; head?: { sha?: string }; base?: { repo?: { html_url?: string } } };
  const head = `${target.split('/')[0]}:${branch}`;
  const open = await http<Pull[]>(`${api(c)}/repos/${target}/pulls?state=open&head=${enc(head)}&base=${enc(base)}`, { headers: headers(c) }).catch((e) => {
    if (notFound(e)) return undefined;
    throw e;
  });
  const pr =
    Array.isArray(open?.data) && open.data[0]
      ? open.data[0]
      : (await http<Pull>(`${api(c)}/repos/${target}/pulls`, { method: 'POST', headers: headers(c), body: { title, head: branch, base, body } })).data;
  return {
    repoUrl: pr.base?.repo?.html_url ?? pr.html_url.replace(/\/pull\/\d+$/, ''),
    prUrl: pr.html_url,
    number: pr.number,
    branch,
    commit: pr.head?.sha ?? commit,
    provider: 'github',
    files: files.map((f) => f.path),
  };
}

const truthy = (v: unknown) => v === true || (typeof v === 'string' && ['true', '1', 'yes'].includes(v.trim().toLowerCase()));

/** One commit on top of `branch` with the files (blobs -> tree -> commit -> ref). Returns the tip; no commit when nothing changed. */
async function commitFiles(c: ScaffoldConfig, target: string, branch: string, files: PublishContext['files'], message: string): Promise<string> {
  const repo = `${api(c)}/repos/${target}`;
  const h = headers(c);
  const tip = (await http<{ object: { sha: string } }>(`${repo}/git/ref/heads/${branch.split('/').map(enc).join('/')}`, { headers: h })).data.object.sha;
  const parent = await http<{ tree: { sha: string } }>(`${repo}/git/commits/${tip}`, { headers: h });
  const entries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  for (const f of files) {
    const blob = await http<{ sha: string }>(`${repo}/git/blobs`, { method: 'POST', headers: h, body: { content: f.content, encoding: 'base64' } });
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.data.sha });
  }
  const tree = await http<{ sha: string }>(`${repo}/git/trees`, { method: 'POST', headers: h, body: { base_tree: parent.data.tree.sha, tree: entries } });
  if (tree.data.sha === parent.data.tree.sha) return tip; // re-run with identical content
  const commit = await http<{ sha: string }>(`${repo}/git/commits`, { method: 'POST', headers: h, body: { message, tree: tree.data.sha, parents: [tip] } });
  await http(`${repo}/git/refs/heads/${branch.split('/').map(enc).join('/')}`, { method: 'PATCH', headers: h, body: { sha: commit.data.sha } });
  return commit.data.sha;
}

type Repo = { html_url: string; default_branch: string; name: string; owner?: { login?: string } };

/**
 * mode: new-repository — create the repository (organisation: POST /orgs/{org}/repos, user: POST /user/repos), then
 * commit the files on the default branch.
 *
 * The repository is created with `auto_init` so it has an initial commit: the Git Data API (blobs/trees) refuses empty
 * repositories. The default branch is renamed to `baseBranch` (default main) when the account default differs, and the
 * scaffold files go in one commit on top of the initial one (template files override the generated README).
 *
 * Re-runs: when the name already exists (422) the repository is filled only if it is empty (e.g. a previous attempt
 * failed between creation and push) or `reuseExisting` is true; otherwise the run fails rather than writing into a
 * repository someone else owns. Pushing onto it again is idempotent (unchanged content creates no commit).
 */
async function newRepository({ config: c, files, title }: PublishContext): Promise<PublishResult> {
  const [owner, name] = c.repo.split('/');
  if (!owner || !name) throw new Error('scaffolder: new-repository needs repo as "owner/name"');
  const h = headers(c);
  const wantedBranch = str(c.baseBranch || 'main');
  const visibility = str(c.visibility || 'private');
  if (!['private', 'internal', 'public'].includes(visibility)) throw new Error(`scaffolder: unknown visibility "${visibility}"`);

  let isOrg = c.ownerType ? c.ownerType === 'org' : true;
  if (!c.ownerType) {
    const me = await http<{ login?: string }>(`${api(c)}/user`, { headers: h }).catch(() => undefined);
    isOrg = me?.data.login?.toLowerCase() !== owner.toLowerCase();
  }
  const createBody = {
    name,
    description: c.description,
    private: visibility !== 'public',
    ...(isOrg ? { visibility } : {}),
    auto_init: true,
  };
  const all = files;
  let created = true;
  let repo: Repo;
  try {
    repo = (
      await http<Repo>(isOrg ? `${api(c)}/orgs/${enc(owner)}/repos` : `${api(c)}/user/repos`, { method: 'POST', headers: h, body: createBody, retry: false })
    ).data;
  } catch (e) {
    if (status(e) !== 422 || !/already exists/i.test(String((e as { body?: string }).body ?? e))) throw e;
    created = false;
    repo = (await http<Repo>(`${api(c)}/repos/${c.repo}`, { headers: h })).data;
    const empty = await http(`${api(c)}/repos/${c.repo}/commits?per_page=1`, { headers: h }).then(
      () => false,
      (err) => {
        if (status(err) === 409) return true; // "Git Repository is empty"
        throw err;
      },
    );
    if (!empty && !truthy(c.reuseExisting)) {
      throw new Error(`scaffolder: repository ${c.repo} already exists and is not empty (set reuseExisting: true to push onto it)`, { cause: e });
    }
    if (empty) {
      // Git Data refuses empty repositories: the contents API creates the initial commit with the first file.
      const [first, ...rest] = files;
      const url = `${api(c)}/repos/${c.repo}/contents/${first!.path.split('/').map(enc).join('/')}`;
      await http(url, {
        method: 'PUT',
        headers: h,
        body: { message: `scaffold: ${first!.path}`, content: first!.content, branch: repo.default_branch || wantedBranch },
      });
      files = rest;
      repo = (await http<Repo>(`${api(c)}/repos/${c.repo}`, { headers: h })).data;
    }
  }
  let branch = repo.default_branch || wantedBranch;
  if (created && branch !== wantedBranch) {
    await http(`${api(c)}/repos/${c.repo}/branches/${enc(branch)}/rename`, { method: 'POST', headers: h, body: { new_name: wantedBranch } });
    branch = wantedBranch;
  }
  const commit = files.length ? await commitFiles(c, c.repo, branch, files, `scaffold: ${title}`) : await tipOf(c, branch);

  const topics = (Array.isArray(c.topics) ? c.topics : (c.topics ?? '').split(',')).map((t) => t.trim()).filter(Boolean);
  if (topics.length) await http(`${api(c)}/repos/${c.repo}/topics`, { method: 'PUT', headers: h, body: { names: topics } });
  if (c.team) {
    if (!isOrg) throw new Error('scaffolder: team permissions only apply to organization repositories');
    await http(`${api(c)}/orgs/${enc(owner)}/teams/${enc(c.team)}/repos/${c.repo}`, {
      method: 'PUT',
      headers: h,
      body: { permission: str(c.teamPermission || 'push') },
    });
  }
  return { repoUrl: repo.html_url, prUrl: null, branch, commit, provider: 'github', files: all.map((f) => f.path) };
}

const tipOf = async (c: ScaffoldConfig, branch: string) =>
  (await http<{ object: { sha: string } }>(`${api(c)}/repos/${c.repo}/git/ref/heads/${branch.split('/').map(enc).join('/')}`, { headers: headers(c) })).data
    .object.sha;

export const githubPublisher: ScaffoldPublisher = {
  provider: 'github',
  modes: ['pull-request', 'new-repository'],
  readTemplate,
  async publish(ctx) {
    if (ctx.config.mode === 'pull-request') return pullRequest(ctx);
    if (ctx.config.mode === 'new-repository') return newRepository(ctx);
    throw unsupportedMode('github', ctx.config.mode);
  },
};
