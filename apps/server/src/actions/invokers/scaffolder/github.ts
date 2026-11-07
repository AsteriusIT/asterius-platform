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

/** mode: pull-request — branch from the base branch, put the files, open a PR. */
async function pullRequest({ config: c, files, branch, title, body }: PublishContext): Promise<PublishResult> {
  const target = c.repo;
  const base = str(c.baseBranch || 'main');
  const baseRef = await http<{ object: { sha: string } }>(`${api(c)}/repos/${target}/git/ref/heads/${encodeURIComponent(base)}`, { headers: headers(c) });
  await http(`${api(c)}/repos/${target}/git/refs`, {
    method: 'POST',
    headers: headers(c),
    body: { ref: `refs/heads/${branch}`, sha: baseRef.data.object.sha },
  });
  let commit = '';
  for (const f of files) {
    const url = `${api(c)}/repos/${target}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    // An existing file on the branch (template overwrites) needs its sha.
    const existing = await http<{ sha?: string }>(`${url}?ref=${encodeURIComponent(branch)}`, { headers: headers(c) }).catch(() => undefined);
    const put = await http<{ commit?: { sha?: string } }>(url, {
      method: 'PUT',
      headers: headers(c),
      body: { message: `scaffold: ${f.path}`, content: f.content, branch, ...(existing?.data.sha ? { sha: existing.data.sha } : {}) },
    });
    commit = put.data.commit?.sha ?? commit;
  }
  const pr = await http<{ html_url: string; number: number; head?: { sha?: string }; base?: { repo?: { html_url?: string } } }>(
    `${api(c)}/repos/${target}/pulls`,
    { method: 'POST', headers: headers(c), body: { title, head: branch, base, body } },
  );
  return {
    repoUrl: pr.data.base?.repo?.html_url ?? pr.data.html_url.replace(/\/pull\/\d+$/, ''),
    prUrl: pr.data.html_url,
    number: pr.data.number,
    branch,
    commit: pr.data.head?.sha ?? commit,
    provider: 'github',
    files: files.map((f) => f.path),
  };
}

export const githubPublisher: ScaffoldPublisher = {
  provider: 'github',
  modes: ['pull-request'],
  readTemplate,
  async publish(ctx) {
    if (ctx.config.mode === 'pull-request') return pullRequest(ctx);
    throw unsupportedMode('github', ctx.config.mode);
  },
};
