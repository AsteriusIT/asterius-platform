import { http } from '../../lib/http.js';
import { requireFields, str, stringValues, type Invoker } from '../types.js';

/**
 * Repository scaffolder: renders a template repository (cookiecutter style `{{ variable }}` placeholders in file
 * paths and text files) and opens a pull request / merge request with the result in the target repository.
 * Placeholders are plain substitutions: no code runs from templates. Providers: github, gitlab.
 */

const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

interface TemplateFile {
  path: string;
  /** base64 content */
  content: string;
}
interface Rendered {
  path: string;
  /** base64 */
  content: string;
}

/** Replace `{{ name }}` / `{{ cookiecutter.name }}`; an unknown variable is an error (a typo would ship). */
export function renderText(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(?:cookiecutter\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`template variable "${name}" is not provided`);
    return vars[name]!;
  });
}

/** Render paths and text contents; binary files are copied as is. Rejects unsafe rendered paths. Exported for tests. */
export function renderFiles(files: TemplateFile[], vars: Record<string, string>, targetDir: string): Rendered[] {
  const dir = targetDir.replace(/^\/+|\/+$/g, '');
  return files.map((f) => {
    const rendered = renderText(f.path, vars);
    const path = [dir && dir !== '.' ? dir : '', rendered].filter(Boolean).join('/');
    if (path.split('/').some((seg) => seg === '..' || seg === '') || path.startsWith('/')) throw new Error(`unsafe path in template: "${rendered}"`);
    const raw = Buffer.from(f.content, 'base64');
    if (raw.includes(0)) return { path, content: f.content }; // binary
    return { path, content: Buffer.from(renderText(raw.toString('utf8'), vars)).toString('base64') };
  });
}

const prefix = (p: string) => p.replace(/^\/+|\/+$/g, '');
const underPrefix = (path: string, pre: string) => (pre ? path.startsWith(`${pre}/`) : true);

// ---------- GitHub ----------
const ghApi = (c: Record<string, unknown>) => str(c.apiUrl || 'https://api.github.com').replace(/\/$/, '');
const ghHeaders = (c: Record<string, unknown>) => ({
  authorization: `Bearer ${str(c.token)}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});

async function githubTemplate(c: Record<string, unknown>): Promise<TemplateFile[]> {
  const repo = str(c.templateRepo);
  const ref = str(c.templateRef || 'HEAD');
  const pre = prefix(str(c.templatePath));
  const tree = await http<{ tree: Array<{ path: string; type: string; sha: string; size?: number }>; truncated?: boolean }>(
    `${ghApi(c)}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    {
      headers: ghHeaders(c),
    },
  );
  if (tree.data.truncated) throw new Error('template repository is too large');
  const blobs = tree.data.tree.filter((e) => e.type === 'blob' && underPrefix(e.path, pre));
  checkLimits(blobs.map((b) => b.size ?? 0));
  const out: TemplateFile[] = [];
  for (const b of blobs) {
    const blob = await http<{ content: string }>(`${ghApi(c)}/repos/${repo}/git/blobs/${b.sha}`, { headers: ghHeaders(c) });
    out.push({ path: pre ? b.path.slice(pre.length + 1) : b.path, content: blob.data.content.replace(/\n/g, '') });
  }
  return out;
}

async function githubPush(c: Record<string, unknown>, files: Rendered[], branch: string, title: string, body: string) {
  const target = str(c.repo);
  const base = str(c.baseBranch || 'main');
  const baseRef = await http<{ object: { sha: string } }>(`${ghApi(c)}/repos/${target}/git/ref/heads/${encodeURIComponent(base)}`, { headers: ghHeaders(c) });
  await http(`${ghApi(c)}/repos/${target}/git/refs`, {
    method: 'POST',
    headers: ghHeaders(c),
    body: { ref: `refs/heads/${branch}`, sha: baseRef.data.object.sha },
  });
  for (const f of files) {
    const url = `${ghApi(c)}/repos/${target}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    // An existing file on the branch (template overwrites) needs its sha.
    const existing = await http<{ sha?: string }>(`${url}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(c) }).catch(() => undefined);
    await http(url, {
      method: 'PUT',
      headers: ghHeaders(c),
      body: { message: `scaffold: ${f.path}`, content: f.content, branch, ...(existing?.data.sha ? { sha: existing.data.sha } : {}) },
    });
  }
  const pr = await http<{ html_url: string; number: number }>(`${ghApi(c)}/repos/${target}/pulls`, {
    method: 'POST',
    headers: ghHeaders(c),
    body: { title, head: branch, base, body },
  });
  return { url: pr.data.html_url, number: pr.data.number };
}

// ---------- GitLab ----------
const glApi = (c: Record<string, unknown>) => `${str(c.baseUrl || 'https://gitlab.com').replace(/\/$/, '')}/api/v4`;
const glHeaders = (c: Record<string, unknown>) => ({ 'private-token': str(c.token) });

async function gitlabTemplate(c: Record<string, unknown>): Promise<TemplateFile[]> {
  const project = encodeURIComponent(str(c.templateRepo));
  const ref = str(c.templateRef || 'HEAD');
  const pre = prefix(str(c.templatePath));
  const paths: string[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await http<Array<{ path: string; type: string }>>(
      `${glApi(c)}/projects/${project}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}${pre ? `&path=${encodeURIComponent(pre)}` : ''}`,
      { headers: glHeaders(c) },
    );
    paths.push(...res.data.filter((e) => e.type === 'blob').map((e) => e.path));
    if (res.data.length < 100) break;
  }
  checkLimits(paths.map(() => 0));
  const out: TemplateFile[] = [];
  for (const p of paths) {
    const res = await fetch(`${glApi(c)}/projects/${project}/repository/files/${encodeURIComponent(p)}/raw?ref=${encodeURIComponent(ref)}`, {
      headers: glHeaders(c),
    });
    if (!res.ok) throw new Error(`gitlab: cannot read template file ${p} (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) throw new Error(`template file ${p} is larger than ${MAX_FILE_BYTES} bytes`);
    out.push({ path: pre ? p.slice(pre.length + 1) : p, content: buf.toString('base64') });
  }
  return out;
}

async function gitlabPush(c: Record<string, unknown>, files: Rendered[], branch: string, title: string, body: string) {
  const project = encodeURIComponent(str(c.repo));
  const base = str(c.baseBranch || 'main');
  await http(`${glApi(c)}/projects/${project}/repository/commits`, {
    method: 'POST',
    headers: glHeaders(c),
    body: {
      branch,
      start_branch: base,
      commit_message: title,
      actions: files.map((f) => ({ action: 'create', file_path: f.path, content: f.content, encoding: 'base64' })),
    },
  });
  const mr = await http<{ web_url: string; iid: number }>(`${glApi(c)}/projects/${project}/merge_requests`, {
    method: 'POST',
    headers: glHeaders(c),
    body: { source_branch: branch, target_branch: base, title, description: body, remove_source_branch: true },
  });
  return { url: mr.data.web_url, number: mr.data.iid };
}

function checkLimits(sizes: number[]) {
  if (sizes.length > MAX_FILES) throw new Error(`template has ${sizes.length} files (max ${MAX_FILES})`);
  if (sizes.some((s) => s > MAX_FILE_BYTES)) throw new Error(`a template file is larger than ${MAX_FILE_BYTES} bytes`);
  if (sizes.reduce((a, b) => a + b, 0) > MAX_TOTAL_BYTES) throw new Error('template is too large');
}

export const scaffolderInvoker: Invoker = {
  info: {
    type: 'scaffolder',
    title: 'Repository scaffolder',
    description: 'Render a template repository with variables and open a pull request in the target repository.',
    fields: [
      { key: 'provider', label: 'Provider', kind: 'select', options: ['github', 'gitlab'], required: true },
      { key: 'templateRepo', label: 'Template repository', kind: 'text', required: true, placeholder: 'org/template-service' },
      { key: 'templatePath', label: 'Template sub-directory', kind: 'text' },
      { key: 'templateRef', label: 'Template ref', kind: 'text', placeholder: 'main' },
      { key: 'repo', label: 'Target repository', kind: 'text', required: true, placeholder: 'org/new-service' },
      { key: 'baseBranch', label: 'Base branch', kind: 'text', placeholder: 'main' },
      { key: 'targetPath', label: 'Directory in the target', kind: 'text', placeholder: '.' },
      { key: 'variables', label: 'Template variables', kind: 'keyvalue' },
      { key: 'title', label: 'Pull request title', kind: 'text' },
      { key: 'token', label: 'Token', kind: 'secret', required: true },
      { key: 'baseUrl', label: 'API URL (GitHub Enterprise / GitLab)', kind: 'text', advanced: true },
    ],
    example: {
      type: 'scaffolder',
      provider: 'github',
      templateRepo: 'my-org/template-service',
      templateRef: 'main',
      repo: 'my-org/{{ inputs.name }}',
      variables: { name: '{{ inputs.name }}', owner: '{{ trigger.user.email }}' },
      title: 'Scaffold {{ inputs.name }}',
      token: '${secret:GITHUB_TOKEN}',
    },
  },
  validate(c) {
    requireFields(c, ['provider', 'templateRepo', 'repo', 'token'], 'scaffolder');
    if (!['github', 'gitlab'].includes(str(c.provider))) throw new Error('scaffolder: provider is github or gitlab');
    if (str(c.targetPath).includes('..')) throw new Error('scaffolder: targetPath cannot contain ..');
  },
  async start({ config, ctx, log }) {
    const c = { ...config, apiUrl: config.apiUrl ?? config.baseUrl };
    const github = str(config.provider) === 'github';
    const vars = stringValues(config.variables);
    await log(`Reading template ${config.templateRepo}`);
    const template = await (github ? githubTemplate(c) : gitlabTemplate(c));
    const files = renderFiles(template, vars, str(config.targetPath || '.'));
    if (!files.length) throw new Error('the template produced no files');
    await log(`Rendered ${files.length} file(s)`);
    const branch = str(config.branch || `scaffold/${ctx.run.id.slice(0, 8)}`);
    const title = str(config.title || `Scaffold from ${config.templateRepo}`);
    const body = `Generated by Asterius run ${ctx.run.url}`;
    const pr = await (github ? githubPush(c, files, branch, title, body) : gitlabPush(c, files, branch, title, body));
    await log(`Opened ${pr.url}`);
    return { status: 'SUCCESS', link: pr.url, result: { pullRequest: pr.url, number: pr.number, branch, files: files.map((f) => f.path) } };
  },
};
