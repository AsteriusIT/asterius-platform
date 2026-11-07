import { http, UpstreamError } from '../../../lib/http.js';
import { guardedDownload } from '../../../lib/netguard.js';
import { str } from '../../types.js';
import type { ScaffoldConfig } from './config.js';
import { checkLimits, MAX_FILE_BYTES, prefix, unsupportedMode } from './render.js';
import type { PublishContext, PublishResult, ScaffoldPublisher, TemplateFile } from './types.js';

const api = (c: ScaffoldConfig) => `${str(c.baseUrl || 'https://gitlab.com').replace(/\/$/, '')}/api/v4`;
const headers = (c: ScaffoldConfig) => ({ 'private-token': str(c.token) });

async function readTemplate(c: ScaffoldConfig): Promise<TemplateFile[]> {
  const project = encodeURIComponent(c.templateRepo);
  const ref = str(c.templateRef || 'HEAD');
  const pre = prefix(c.templatePath);
  const paths: string[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await http<Array<{ path: string; type: string }>>(
      `${api(c)}/projects/${project}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}${pre ? `&path=${encodeURIComponent(pre)}` : ''}`,
      { headers: headers(c) },
    );
    paths.push(...res.data.filter((e) => e.type === 'blob').map((e) => e.path));
    if (res.data.length < 100) break;
  }
  checkLimits(paths.map(() => 0));
  const out: TemplateFile[] = [];
  for (const p of paths) {
    const res = await guardedDownload(`${api(c)}/projects/${project}/repository/files/${encodeURIComponent(p)}/raw?ref=${encodeURIComponent(ref)}`, {
      headers: headers(c),
    });
    if (!res.ok) throw new Error(`gitlab: cannot read template file ${p} (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) throw new Error(`template file ${p} is larger than ${MAX_FILE_BYTES} bytes`);
    out.push({ path: pre ? p.slice(pre.length + 1) : p, content: buf.toString('base64') });
  }
  return out;
}

/** GET that maps a 404 to null. */
async function find<T>(url: string, c: ScaffoldConfig): Promise<T | null> {
  try {
    return (await http<T>(url, { headers: headers(c) })).data;
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 404) return null;
    throw e;
  }
}

/** Paths of the files present on `ref` (so re-runs update them instead of failing on "already exists"). */
async function existingPaths(c: ScaffoldConfig, project: string, ref: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    const tree = await find<Array<{ path: string; type: string }>>(
      `${api(c)}/projects/${project}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`,
      c,
    );
    if (!tree) break; // empty repository or unknown ref
    for (const e of tree) if (e.type === 'blob') out.add(e.path);
    if (tree.length < 100) break;
  }
  return out;
}

/**
 * Commit actions for the files that differ from the branch: `create` for new paths, `update` for existing ones whose
 * content changed. Identical files are dropped (GitLab would otherwise record a no-change commit), so an empty result
 * means the re-run has nothing to commit.
 */
async function actions(c: ScaffoldConfig, project: string, ref: string, files: PublishContext['files'], existing: Set<string>) {
  const out: Array<{ action: string; file_path: string; content: string; encoding: string }> = [];
  for (const f of files) {
    if (existing.has(f.path)) {
      const cur = await find<{ content?: string; encoding?: string }>(
        `${api(c)}/projects/${project}/repository/files/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(ref)}`,
        c,
      );
      if (cur?.content && (cur.encoding ?? 'base64') === 'base64' && cur.content.replace(/\s/g, '') === f.content) continue;
    }
    out.push({ action: existing.has(f.path) ? 'update' : 'create', file_path: f.path, content: f.content, encoding: 'base64' });
  }
  return out;
}

/** Tip commit of a branch ('' when unknown). */
async function tip(c: ScaffoldConfig, project: string, branch: string): Promise<string> {
  const b = await find<{ commit?: { id?: string } }>(`${api(c)}/projects/${project}/repository/branches/${encodeURIComponent(branch)}`, c);
  return b?.commit?.id ?? '';
}

/** Commits `changes` on `branch` unless there are none; returns the new commit id or the current branch tip. */
async function commitOrTip(c: ScaffoldConfig, project: string, body: Record<string, unknown>, changes: Awaited<ReturnType<typeof actions>>): Promise<string> {
  if (!changes.length) return tip(c, project, String(body.branch));
  const res = await http<{ id?: string }>(`${api(c)}/projects/${project}/repository/commits`, {
    method: 'POST',
    headers: headers(c),
    body: { ...body, actions: changes },
  });
  return res.data.id ?? '';
}

/**
 * mode: pull-request — one commit on the branch, then a merge request. Re-runs: an existing branch gets the commit
 * on top of it, an open MR for the same source/target branches is reused.
 */
async function mergeRequest({ config: c, files, branch, title, body }: PublishContext): Promise<PublishResult> {
  const project = encodeURIComponent(c.repo);
  const base = str(c.baseBranch || 'main');
  const branchExists = !!(await find(`${api(c)}/projects/${project}/repository/branches/${encodeURIComponent(branch)}`, c));
  const existing = branchExists ? await existingPaths(c, project, branch) : new Set<string>();
  const commit = await commitOrTip(
    c,
    project,
    { branch, ...(branchExists ? {} : { start_branch: base }), commit_message: title },
    await actions(c, project, branch, files, existing),
  );
  const open = await http<Array<{ web_url: string; iid: number; sha?: string }>>(
    `${api(c)}/projects/${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(base)}`,
    { headers: headers(c) },
  );
  const mr = open.data[0]
    ? open.data[0]
    : (
        await http<{ web_url: string; iid: number; sha?: string }>(`${api(c)}/projects/${project}/merge_requests`, {
          method: 'POST',
          headers: headers(c),
          body: { source_branch: branch, target_branch: base, title, description: body, remove_source_branch: true },
        })
      ).data;
  return {
    repoUrl: mr.web_url.replace(/\/(-\/)?merge_requests\/\d+$/, ''),
    prUrl: mr.web_url,
    number: mr.iid,
    branch,
    commit: commit || mr.sha || '',
    provider: 'gitlab',
    files: files.map((f) => f.path),
  };
}

interface GitlabProject {
  id: number;
  web_url: string;
  default_branch?: string | null;
  empty_repo?: boolean;
}

/**
 * mode: new-repository — create the project in its namespace and push the files as the initial commit.
 * `repo` is the project path ("group/sub/name", or just "name" with `namespace`). An existing project is only
 * used when it is empty or `reuseExisting: true` (then the files are committed on top of its default branch).
 */
async function newProject({ config: c, files, title }: PublishContext): Promise<PublishResult> {
  const segments = c.repo.split('/').filter(Boolean);
  const path = segments.pop()!;
  const namespace = (c.namespace ? c.namespace.split('/').filter(Boolean) : segments).join('/');
  const full = [namespace, path].filter(Boolean).join('/');
  const wanted = c.defaultBranch || c.baseBranch || 'main';
  let project = await find<GitlabProject>(`${api(c)}/projects/${encodeURIComponent(full)}`, c);
  let branch = wanted;
  let existing = new Set<string>();
  if (project) {
    const empty = project.empty_repo ?? !project.default_branch;
    if (!empty && !c.reuseExisting) {
      throw new Error(`gitlab: project ${full} already exists and is not empty (set reuseExisting: true to commit into it)`);
    }
    if (!empty) {
      branch = project.default_branch || wanted;
      existing = await existingPaths(c, String(project.id), branch);
    }
  } else {
    let namespaceId: number | undefined;
    if (namespace) {
      const ns = await find<{ id: number }>(`${api(c)}/namespaces/${encodeURIComponent(namespace)}`, c);
      if (!ns) throw new Error(`gitlab: namespace ${namespace} not found`);
      namespaceId = ns.id;
    }
    project = (
      await http<GitlabProject>(`${api(c)}/projects`, {
        method: 'POST',
        headers: headers(c),
        body: {
          name: path,
          path,
          ...(namespaceId ? { namespace_id: namespaceId } : {}),
          description: c.description,
          visibility: c.visibility ?? 'private',
          default_branch: wanted,
          initialize_with_readme: false,
        },
      })
    ).data;
  }
  const commit = await commitOrTip(c, String(project.id), { branch, commit_message: title }, await actions(c, String(project.id), branch, files, existing));
  return {
    repoUrl: project.web_url,
    prUrl: null,
    number: null,
    branch,
    commit,
    provider: 'gitlab',
    files: files.map((f) => f.path),
  };
}

export const gitlabPublisher: ScaffoldPublisher = {
  provider: 'gitlab',
  modes: ['pull-request', 'new-repository'],
  readTemplate,
  async publish(ctx) {
    if (ctx.config.mode === 'pull-request') return mergeRequest(ctx);
    if (ctx.config.mode === 'new-repository') return newProject(ctx);
    throw unsupportedMode('gitlab', ctx.config.mode);
  },
};
