import { http } from '../../../lib/http.js';
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

/** mode: pull-request — one commit on a new branch from the base branch, then a merge request. */
async function mergeRequest({ config: c, files, branch, title, body }: PublishContext): Promise<PublishResult> {
  const project = encodeURIComponent(c.repo);
  const base = str(c.baseBranch || 'main');
  const commit = await http<{ id?: string }>(`${api(c)}/projects/${project}/repository/commits`, {
    method: 'POST',
    headers: headers(c),
    body: {
      branch,
      start_branch: base,
      commit_message: title,
      actions: files.map((f) => ({ action: 'create', file_path: f.path, content: f.content, encoding: 'base64' })),
    },
  });
  const mr = await http<{ web_url: string; iid: number; sha?: string }>(`${api(c)}/projects/${project}/merge_requests`, {
    method: 'POST',
    headers: headers(c),
    body: { source_branch: branch, target_branch: base, title, description: body, remove_source_branch: true },
  });
  return {
    repoUrl: mr.data.web_url.replace(/\/(-\/)?merge_requests\/\d+$/, ''),
    prUrl: mr.data.web_url,
    number: mr.data.iid,
    branch,
    commit: commit.data.id ?? mr.data.sha ?? '',
    provider: 'gitlab',
    files: files.map((f) => f.path),
  };
}

export const gitlabPublisher: ScaffoldPublisher = {
  provider: 'gitlab',
  modes: ['pull-request'],
  readTemplate,
  async publish(ctx) {
    if (ctx.config.mode === 'pull-request') return mergeRequest(ctx);
    throw unsupportedMode('gitlab', ctx.config.mode);
  },
};
