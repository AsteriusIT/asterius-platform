import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadPlugins } from '../src/plugins.js';
import { getSource } from '../src/integrations/sources/index.js';
import { getInvoker } from '../src/actions/invokers/index.js';
import { silentLog } from './helpers.js';
import type { SourceEnv } from '../src/integrations/types.js';

const plugin = (type: string) => `
export default function register(api) {
  api.registerSource({
    info: { type: '${type}', title: 'T', description: 'd', example: { type: '${type}' } },
    validate() {},
    async *list() { yield [{ id: 1 }]; },
  });
}
`;

describe('plugin loading', () => {
  it('loads files and directories from the plugin directory and skips broken plugins', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
    fs.writeFileSync(path.join(dir, 'a.mjs'), plugin('plug-a'));
    fs.mkdirSync(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'b', 'index.mjs'), plugin('plug-b'));
    fs.writeFileSync(path.join(dir, 'broken.mjs'), 'throw new Error("boom")');
    fs.writeFileSync(path.join(dir, 'bad-type.mjs'), plugin('Bad Type'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const loaded = await loadPlugins(silentLog, { dir, packages: [] });
    expect(loaded).toEqual(['a.mjs', path.join('b', 'index.mjs')]);
    expect(getSource('plug-a').info.title).toBe('T');
    expect(getSource('plug-b')).toBeTruthy();
  });
});

async function service(handler: (path: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const s = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      calls.push({ path: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(handler(req.url ?? '', body)));
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, calls, close: () => new Promise((r) => s.close(r)) };
}

describe('external (out-of-process) plugins', () => {
  it('lists through the HTTP contract with cursor paging and state', async () => {
    const svc = await service((_p, body) =>
      body.cursor ? { items: [{ id: 3 }], state: { since: 'x' } } : { items: [{ id: 1 }, { id: 2 }], nextCursor: 'c2' },
    );
    let state: unknown;
    const env: SourceEnv = {
      config: { url: svc.url, project: 'PLAT' },
      log: () => undefined,
      startedAt: 'now',
      setState: (s) => (state = s),
      incomplete: () => undefined,
    };
    const items: unknown[] = [];
    for await (const page of getSource('external').list!('issue', env)) items.push(...page);
    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(state).toEqual({ since: 'x' });
    expect(svc.calls[0]).toMatchObject({ path: '/list', body: { kind: 'issue', config: { project: 'PLAT' }, startedAt: 'now' } });
    await svc.close();
  });

  it('rejects malformed answers and drives the invoker contract', async () => {
    const bad = await service(() => ({ nope: true }));
    const env: SourceEnv = { config: { url: bad.url }, log: () => undefined, startedAt: '', setState: () => undefined, incomplete: () => undefined };
    await expect(
      (async () => {
        for await (const page of getSource('external').list!('x', env)) void page;
      })(),
    ).rejects.toThrow(/invalid \/list response/);
    await bad.close();

    const svc = await service((p) => (p === '/start' ? { status: 'IN_PROGRESS', state: { id: 7 } } : { status: 'SUCCESS', result: { done: true } }));
    const inv = getInvoker('external');
    const ctx = {
      run: { id: 'r1', url: '', callback: { url: '', token: '' } },
      action: { identifier: 'a', title: 'A', blueprint: null },
      inputs: { title: 'T' },
      entity: null,
      trigger: { user: { id: 'u', email: 'e', name: 'n' }, at: '' },
      steps: {},
    };
    const started = await inv.start({ ctx, config: { url: svc.url, project: 'PLAT' }, log: async () => undefined });
    expect(started).toMatchObject({ status: 'IN_PROGRESS', state: { id: 7 } });
    const polled = await inv.poll!({ ctx, config: { url: svc.url }, log: async () => undefined }, { id: 7 });
    expect(polled).toMatchObject({ status: 'SUCCESS', result: { done: true } });
    expect(svc.calls[1]!.body).toMatchObject({ state: { id: 7 } });
    await svc.close();
  });
});
