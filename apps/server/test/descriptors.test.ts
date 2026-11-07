import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { descriptorsSource } from '../src/integrations/sources/descriptors.js';
import type { SourceEnv } from '../src/integrations/types.js';

describe('descriptors source (github provider)', () => {
  it('finds descriptors, expands entities, skips repositories without one and reports invalid YAML', async () => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://x');
      if (url.pathname === '/orgs/acme/repos') {
        const repos = ['one', 'two', 'three', 'four'].map((n) => ({
          name: n,
          full_name: `acme/${n}`,
          html_url: `https://host/acme/${n}`,
          default_branch: 'main',
          archived: false,
        }));
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(repos));
      }
      const repo = /repos\/acme\/(\w+)\/contents/.exec(url.pathname)?.[1];
      const files: Record<string, string> = {
        one: 'name: svc-one\ntier: 1\nowner: payments\n',
        two: 'name: base\nentities:\n  - name: part-a\n  - name: part-b\n',
        four: 'name: [unterminated',
      };
      if (repo && files[repo] !== undefined) res.writeHead(200, { 'content-type': 'text/plain' }).end(files[repo]);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const api = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
    const logs: string[] = [];
    const incomplete: string[] = [];
    const env: SourceEnv = {
      config: { provider: 'github', org: 'acme', token: 't', apiUrl: api.url },
      log: (l) => logs.push(l),
      startedAt: '',
      setState: () => undefined,
      incomplete: (r) => incomplete.push(r),
    };
    const items: Array<{ repository: { name: string }; descriptor: { name: string; tier?: number } }> = [];
    for await (const page of descriptorsSource.list!('descriptor', env)) items.push(...(page as typeof items));
    expect(items.map((i) => i.descriptor.name).sort()).toEqual(['part-a', 'part-b', 'svc-one']);
    expect(items.find((i) => i.descriptor.name === 'svc-one')?.descriptor.tier).toBe(1);
    expect(items.find((i) => i.descriptor.name === 'part-a')?.repository.name).toBe('two');
    expect(incomplete).toEqual(['acme/four: invalid descriptor']);
    expect(logs.join('\n')).toMatch(/4 repositories scanned, 3 descriptor/);
    await api.close();
  });

  it('validates the configuration', () => {
    expect(() => descriptorsSource.validate({ provider: 'bitbucket' })).toThrow(/provider/);
    expect(() => descriptorsSource.validate({ provider: 'github', org: 'a', token: 't', path: '../x' })).toThrow(/relative/);
    expect(() => descriptorsSource.validate({ provider: 'gitlab', group: 'g' })).toThrow(/token/);
    expect(() => descriptorsSource.validate({ provider: 'github', org: 'a', token: 't' })).not.toThrow();
  });
});
