import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { assertAddressAllowed } from '../lib/netguard.js';
import { resolveValue } from '../secrets.js';

const run = promisify(execFile);

/**
 * Configuration as code from an organization's own Git repository: a shallow clone per organization under
 * DATA_DIR/config-repos, refreshed by the config loader. Hardened for repositories controlled by tenants: https
 * only, the host must pass the outbound SSRF guard, no symlinks, no hooks, no credential prompts, size limits.
 * The token (a `${secret:NAME}` of the organization) is sent as an HTTP header, never written to disk.
 */

const MAX_REPO_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export interface GitSource {
  url: string;
  branch: string;
  path: string;
  token: string | null;
}

async function assertHostAllowed(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('Git repositories are pulled over https');
  if (u.username || u.password) throw new Error('Put credentials in the token secret, not in the URL');
  const addrs = await dns.lookup(u.hostname, { all: true });
  for (const a of addrs) assertAddressAllowed(u.hostname, a.address);
}

/** git with hardening flags; the token travels in an extra header (Basic, as GitHub/GitLab/Azure DevOps accept). */
async function git(args: string[], cwd: string | undefined, token: string | undefined) {
  const flags = [
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    '-c',
    'core.symlinks=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'credential.helper=',
    '-c',
    'http.followRedirects=false',
    ...(token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : []),
  ];
  return run('git', [...flags, ...args], {
    cwd,
    timeout: TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
}

function dirSize(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) n += fs.statSync(path.join(e.parentPath, e.name)).size;
  return n;
}

/** Fetch the branch (clone the first time); returns the directory holding the configuration files and the commit. */
export async function pullGitSource(orgId: string, src: GitSource): Promise<{ dir: string; revision: string }> {
  await assertHostAllowed(src.url);
  const token = src.token ? await resolveValue(src.token) : undefined; // resolves in the organization's context
  const repo = path.join(config.DATA_DIR, 'config-repos', orgId.replace(/[^A-Za-z0-9-]/g, '_'));
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  const fresh = !fs.existsSync(path.join(repo, '.git'));
  if (fresh) {
    fs.rmSync(repo, { recursive: true, force: true });
    await git(['clone', '--depth', '1', '--single-branch', '--branch', src.branch, '--no-tags', src.url, repo], undefined, token);
  } else {
    await git(['remote', 'set-url', 'origin', src.url], repo, undefined);
    await git(['fetch', '--depth', '1', '--no-tags', 'origin', src.branch], repo, token);
    await git(['reset', '--hard', 'FETCH_HEAD'], repo, undefined);
    await git(['clean', '-fdx'], repo, undefined);
  }
  if (dirSize(repo) > MAX_REPO_BYTES) throw new Error('Repository too large for configuration (max 50 MB)');
  const { stdout } = await git(['rev-parse', 'HEAD'], repo, undefined);
  const dir = path.resolve(repo, src.path || '.');
  if (dir !== repo && !dir.startsWith(`${repo}${path.sep}`)) throw new Error('path must stay inside the repository');
  if (!fs.existsSync(dir)) throw new Error(`path "${src.path}" does not exist on ${src.branch}`);
  return { dir, revision: stdout.trim() };
}

/** Remove the local clone (source changed or organization deleted). */
export function forgetGitSource(orgId: string) {
  fs.rmSync(path.join(config.DATA_DIR, 'config-repos', orgId.replace(/[^A-Za-z0-9-]/g, '_')), { recursive: true, force: true });
}
