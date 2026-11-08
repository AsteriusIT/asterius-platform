import { randomUUID } from 'node:crypto';
import { later, now, run } from '../db.js';
import { http, UpstreamError } from '../lib/http.js';
import { sleep } from '../lib/resilience.js';

/**
 * The Portal repo through the Azure DevOps Git REST API (no git binary), and the serialized commit queue of V2
 * (docs/V2.md §10.4): every write goes through `commitSerialized`, which
 *  - serializes writers to one branch inside the process (promise chain) and across replicas (a lease row claimed
 *    with a conditional UPDATE), so portal commits do not race each other;
 *  - pushes with `oldObjectId` = the branch head it read; when someone else moved the branch meanwhile (a manual
 *    commit, another system) the push is rejected as stale, and the queue re-reads the head, re-plans the change on
 *    top of it and retries with backoff (bounded). This is the "rebase and retry on non-fast-forward".
 */

const API = 'api-version=7.1';

export interface PortalRepo {
  /** Web URL of the repository: `https://dev.azure.com/<org>/<project>/_git/<repo>`. */
  url: string;
  branch: string;
  /** PAT (Basic) or `Bearer <Entra token>`. */
  token: string;
}

export function parseRepoUrl(url: string): { origin: string; org: string; project: string; repo: string; api: string; web: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`repository: "${url}" is not a URL (https://dev.azure.com/<org>/<project>/_git/<repo>)`);
  }
  const m = /^\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)\/?$/.exec(u.pathname);
  if (!m || u.username || u.password)
    throw new Error(`repository: "${url}" is not an Azure DevOps repository URL (https://dev.azure.com/<org>/<project>/_git/<repo>)`);
  const [, org, project, repo] = m.map((s) => decodeURIComponent(s)) as [string, string, string, string];
  const base = `${u.origin}/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;
  return {
    origin: u.origin,
    org,
    project,
    repo,
    api: `${base}/_apis/git/repositories/${encodeURIComponent(repo)}`,
    web: `${base}/_git/${encodeURIComponent(repo)}`,
  };
}

const auth = (token: string) => ({ authorization: token.startsWith('Bearer ') ? token : `Basic ${Buffer.from(`:${token}`).toString('base64')}` });

/** Browser links. */
export const fileUrl = (r: PortalRepo, path: string) =>
  `${parseRepoUrl(r.url).web}?path=${encodeURIComponent(`/${path}`)}&version=GB${encodeURIComponent(r.branch)}`;
export const commitUrl = (r: PortalRepo, id: string) => `${parseRepoUrl(r.url).web}/commit/${id}`;

/** Head commit of the branch (null: the branch does not exist). */
export async function branchHead(r: PortalRepo): Promise<string | null> {
  const res = await http<{ value?: Array<{ name: string; objectId: string }> }>(
    `${parseRepoUrl(r.url).api}/refs?filter=${encodeURIComponent(`heads/${r.branch}`)}&${API}`,
    { headers: auth(r.token) },
  );
  return res.data.value?.find((x) => x.name === `refs/heads/${r.branch}`)?.objectId ?? null;
}

/** Content of a file at a commit (or at the branch head when `commit` is omitted); null when it does not exist. */
export async function readFile(r: PortalRepo, path: string, commit?: string): Promise<string | null> {
  const version = commit
    ? `&versionDescriptor.versionType=commit&versionDescriptor.version=${encodeURIComponent(commit)}`
    : `&versionDescriptor.versionType=branch&versionDescriptor.version=${encodeURIComponent(r.branch)}`;
  try {
    const res = await http<{ content?: string } | string>(
      `${parseRepoUrl(r.url).api}/items?path=${encodeURIComponent(`/${path}`)}${version}&includeContent=true&$format=json&${API}`,
      { headers: auth(r.token) },
    );
    return typeof res.data === 'string' ? res.data : (res.data.content ?? '');
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 404) return null;
    throw e;
  }
}

export interface Change {
  changeType: 'add' | 'edit' | 'delete';
  path: string;
  content?: string;
}

/** The push was made against a head that is no longer current (someone else pushed meanwhile). */
export function isStalePush(e: unknown): boolean {
  if (!(e instanceof UpstreamError)) return false;
  if (e.status === 409) return true;
  return (e.status === 400 || e.status === 412) && /TF401028|GitReferenceStale|stale|already been updated/i.test(e.body ?? e.message);
}

async function push(r: PortalRepo, oldObjectId: string, message: string, changes: Change[]): Promise<string> {
  const res = await http<{ commits?: Array<{ commitId: string }>; refUpdates?: Array<{ newObjectId?: string }> }>(`${parseRepoUrl(r.url).api}/pushes?${API}`, {
    method: 'POST',
    headers: auth(r.token),
    retry: false, // conflicts are handled by the queue (re-read, re-plan); a blind resend could double-apply
    body: {
      refUpdates: [{ name: `refs/heads/${r.branch}`, oldObjectId }],
      commits: [
        {
          comment: message,
          changes: changes.map((c) => ({
            changeType: c.changeType,
            item: { path: `/${c.path}` },
            ...(c.changeType === 'delete' ? {} : { newContent: { content: c.content ?? '', contentType: 'rawtext' } }),
          })),
        },
      ],
    },
  });
  return res.data.commits?.[0]?.commitId ?? res.data.refUpdates?.[0]?.newObjectId ?? '';
}

// ---------- serialization ----------

const chains = new Map<string, Promise<unknown>>();
/** One writer per key in this process; others queue behind it in arrival order. */
async function inProcess<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(key, next);
  try {
    return await next;
  } finally {
    if (chains.get(key) === next) chains.delete(key);
  }
}

export interface QueueOptions {
  /** Push attempts before giving up on conflicts. */
  attempts?: number;
  /** First backoff delay (doubles, with jitter, capped at 5 s). */
  backoffMs?: number;
  /** How long a replica holds the lease at most (a crashed holder frees it after this). */
  leaseMs?: number;
  /** How long to wait for the lease before failing (the step can then be retried). */
  waitMs?: number;
}

/**
 * Cross-replica lease on the branch, in the shared database: a row of `ai_leases` (generic name / locked_until /
 * holder columns) claimed with a conditional UPDATE. The holder token is kept in `last_run_at`, so only the holder
 * releases it. The lease only avoids contention: correctness comes from `oldObjectId` on the push.
 */
async function withLease<T>(name: string, o: Required<QueueOptions>, fn: () => Promise<T>): Promise<T> {
  const holder = `holder:${randomUUID()}`;
  await run('INSERT INTO ai_leases (name, locked_until) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', name, new Date(0).toISOString());
  const deadline = Date.now() + o.waitMs;
  for (let i = 0; ; i++) {
    const t = now();
    const { changes } = await run(
      'UPDATE ai_leases SET locked_until = ?, last_run_at = ? WHERE name = ? AND locked_until < ?',
      later(o.leaseMs),
      holder,
      name,
      t,
    );
    if (changes > 0) break;
    if (Date.now() >= deadline) throw new Error(`commit queue: another replica holds the lease on ${name} (waited ${Math.round(o.waitMs / 1000)}s); retry`);
    await sleep(Math.min(100 * 2 ** Math.min(i, 4), 1000) + Math.random() * 50);
  }
  try {
    return await fn();
  } finally {
    await run('UPDATE ai_leases SET locked_until = ? WHERE name = ? AND last_run_at = ?', new Date(0).toISOString(), name, holder).catch(() => undefined);
  }
}

export interface Plan {
  message: string;
  changes: Change[];
}

export interface CommitResult {
  /** The new commit, or the current head when there was nothing to change. */
  commitId: string;
  noop: boolean;
  attempts: number;
}

/**
 * Plan a change against the current head and push it, serialized per branch. `plan` receives a reader bound to the
 * head it is planning against; it is called again after a conflict, so it must be a pure function of what it reads.
 * Return `null` (or no changes) when the repository already has the desired content.
 */
export async function commitSerialized(
  r: PortalRepo,
  plan: (read: (path: string) => Promise<string | null>, head: string) => Promise<Plan | null>,
  opts: QueueOptions & { log?: (m: string) => Promise<void> } = {},
): Promise<CommitResult> {
  const o: Required<QueueOptions> = { attempts: 6, backoffMs: 250, leaseMs: 120_000, waitMs: 90_000, ...opts };
  const { repo, org, project } = parseRepoUrl(r.url);
  const key = `v2-commit:${org}/${project}/${repo}#${r.branch}`;
  return inProcess(key, () =>
    withLease(key, o, async () => {
      for (let attempt = 1; ; attempt++) {
        const head = await branchHead(r);
        if (!head) throw new Error(`commit queue: branch "${r.branch}" not found in ${repo}`);
        const p = await plan((path) => readFile(r, path, head), head);
        if (!p || !p.changes.length) return { commitId: head, noop: true, attempts: attempt };
        try {
          return { commitId: await push(r, head, p.message, p.changes), noop: false, attempts: attempt };
        } catch (e) {
          if (!isStalePush(e) || attempt >= o.attempts) throw e;
          const delay = Math.min(o.backoffMs * 2 ** (attempt - 1), 5000) * (0.75 + Math.random() * 0.5);
          await opts.log?.(`Branch ${r.branch} moved since ${head.slice(0, 8)} (attempt ${attempt}); re-reading and retrying in ${Math.round(delay)} ms`);
          await sleep(delay);
        }
      }
    }),
  );
}
