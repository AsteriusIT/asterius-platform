import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process fake of the Azure DevOps Git REST API used by the V2 commit queue: refs, items (content at a commit or a
 * branch) and pushes with `oldObjectId` checks (409 TF401028 when the branch moved). `onPush` runs before a push is
 * applied: tests use it to make another writer land first.
 */
export interface FakeCommit {
  id: string;
  parent: string | null;
  message: string;
  files: Map<string, string>;
}
export interface PushBody {
  refUpdates: Array<{ name: string; oldObjectId: string }>;
  commits: Array<{ comment: string; changes: Array<{ changeType: string; item: { path: string }; newContent?: { content: string; contentType: string } }> }>;
}

export async function fakeAdoGit(initial: Record<string, string> = {}) {
  let n = 0;
  const commits = new Map<string, FakeCommit>();
  const mk = (parent: string | null, message: string, files: Map<string, string>) => {
    const id = `c${String(++n).padStart(39, '0')}`;
    commits.set(id, { id, parent, message, files });
    return id;
  };
  let head = mk(null, 'init', new Map(Object.entries(initial).map(([k, v]) => [`/${k}`, v])));
  const pushes: Array<{ body: PushBody; status: number; auth?: string }> = [];
  const calls: string[] = [];
  let onPush: ((attempt: number) => void | Promise<void>) | undefined;
  let pushInFlight = 0;
  let maxConcurrentPushes = 0;

  /** Another writer commits directly (a human, another system). */
  const commitDirect = (path: string, content: string | null, message = 'manual') => {
    const files = new Map(commits.get(head)!.files);
    if (content === null) files.delete(`/${path}`);
    else files.set(`/${path}`, content);
    head = mk(head, message, files);
    return head;
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const url = new URL(req.url!, 'http://x');
      calls.push(`${req.method} ${url.pathname}`);
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const m = /^\/org\/Platform\/_apis\/git\/repositories\/portal-resources\/(refs|items|pushes)$/.exec(url.pathname);
      if (!m) return send(404, { message: 'not found' });
      if (m[1] === 'refs') return send(200, { value: [{ name: 'refs/heads/main', objectId: head }] });
      if (m[1] === 'items') {
        const type = url.searchParams.get('versionDescriptor.versionType');
        const ver = url.searchParams.get('versionDescriptor.version');
        const at = type === 'commit' ? commits.get(ver!) : commits.get(head);
        const content = at?.files.get(url.searchParams.get('path')!);
        return content === undefined
          ? send(404, { message: 'TF401174: The item could not be found' })
          : send(200, { path: url.searchParams.get('path'), content });
      }
      const body = JSON.parse(raw) as PushBody;
      pushInFlight++;
      maxConcurrentPushes = Math.max(maxConcurrentPushes, pushInFlight);
      try {
        await onPush?.(pushes.length + 1);
        await new Promise((r) => setTimeout(r, 5));
        const old = body.refUpdates[0]!.oldObjectId;
        if (old !== head) {
          pushes.push({ body, status: 409, auth: req.headers.authorization });
          return send(409, { message: "TF401028: The reference 'refs/heads/main' has already been updated by another client, so you cannot update it." });
        }
        const files = new Map(commits.get(head)!.files);
        for (const ch of body.commits[0]!.changes) {
          const exists = files.has(ch.item.path);
          if ((ch.changeType === 'add' && exists) || (ch.changeType !== 'add' && !exists)) {
            pushes.push({ body, status: 400, auth: req.headers.authorization });
            return send(400, { message: `bad ${ch.changeType} on ${ch.item.path}` });
          }
          if (ch.changeType === 'delete') files.delete(ch.item.path);
          else files.set(ch.item.path, ch.newContent!.content);
        }
        head = mk(head, body.commits[0]!.comment, files);
        pushes.push({ body, status: 201, auth: req.headers.authorization });
        return send(201, { commits: [{ commitId: head }], refUpdates: [{ newObjectId: head }] });
      } finally {
        pushInFlight--;
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/org/Platform/_git/portal-resources`,
    pushes,
    calls,
    commitDirect,
    head: () => head,
    file: (path: string) => commits.get(head)!.files.get(`/${path}`),
    commit: (id: string) => commits.get(id),
    setOnPush: (fn: typeof onPush) => (onPush = fn),
    maxConcurrentPushes: () => maxConcurrentPushes,
    close: () => new Promise((r) => server.close(r)),
  };
}
