import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { getSource } from '../src/integrations/sources/index.js';
import { PRESETS, buildRequest, fill } from '../src/integrations/sources/presets.js';
import type { SourceEnv } from '../src/integrations/types.js';

async function api(handler: (req: IncomingMessage, base: string) => unknown) {
  const seen: Array<{ url: string; headers: IncomingMessage['headers'] }> = [];
  const s = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(handler(req, base())));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const base = () => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { url: base(), seen, close: () => new Promise((r) => s.close(r)) };
}
async function collect(type: string, kind: string, config: Record<string, unknown>) {
  const env: SourceEnv = { config, log: () => undefined, startedAt: '', setState: () => undefined, incomplete: () => undefined };
  const out: unknown[] = [];
  for await (const page of getSource(type).list!(kind, env)) out.push(...page);
  return out;
}

describe('connector presets', () => {
  it('fills placeholders and every preset ships a valid example', () => {
    expect(fill('/orgs/{org}/x?{q|fallback}', { org: 'a b' })).toBe('/orgs/a b/x?fallback');
    expect(() => fill('/{org}', {})).toThrow(/missing configuration "org"/);
    for (const p of PRESETS) {
      const src = getSource(p.type);
      const ex = src.info.example as { config: Record<string, unknown>; mappings: Array<{ kind: string }> };
      expect(() => src.validate({ ...ex.config, baseUrl: ex.config.baseUrl ?? 'https://x.test' }), p.type).not.toThrow();
      for (const m of ex.mappings) expect(Object.keys(p.kinds), p.type).toContain(m.kind);
      for (const kind of Object.keys(p.kinds)) {
        const r = buildRequest(p, kind, { ...ex.config, baseUrl: ex.config.baseUrl ?? 'https://x.test', jql: 'a = b', organization: 'o', orgId: 'i' });
        expect(r.url, `${p.type}/${kind}`).toMatch(/^https:\/\//);
      }
    }
    expect(() => getSource('pagerduty').validate({})).toThrow(/token/);
    expect(() => getSource('okta').validate({ token: 't' })).toThrow(/baseUrl/);
  });

  it('PagerDuty: offset paging with the vendor headers', async () => {
    const s = await api((req) => {
      const offset = Number(new URL(req.url ?? '', 'http://x').searchParams.get('offset') ?? 0);
      return { services: offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: `S${i}` })) : [{ id: 'last' }] };
    });
    const items = await collect('pagerduty', 'service', { baseUrl: s.url, token: 'pd' });
    expect(items).toHaveLength(101);
    expect(s.seen[0]!.headers.authorization).toBe('Token token=pd');
    expect(s.seen[1]!.url).toContain('offset=100');
    await s.close();
  });

  it('Entra directory: follows @odata.nextLink', async () => {
    const s = await api((req, base) =>
      req.url?.includes('skip') ? { value: [{ mail: 'b@x' }] } : { value: [{ mail: 'a@x' }], '@odata.nextLink': `${base}/v1.0/users?skip=1` },
    );
    const items = await collect('entra-directory', 'user', { baseUrl: s.url, token: 'tok' });
    expect(items).toEqual([{ mail: 'a@x' }, { mail: 'b@x' }]);
    expect(s.seen[0]!.headers.authorization).toBe('Bearer tok');
    await s.close();
  });

  it('Terraform Cloud workspaces: JSON:API page numbers; Jira: cursor and JQL', async () => {
    const tfc = await api((req) => {
      const page = Number(new URL(req.url ?? '', 'http://x').searchParams.get('page[number]') ?? 1);
      return { data: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: `ws-${i}` })) : [{ id: 'ws-last' }] };
    });
    expect(await collect('terraform-cloud-workspaces', 'workspace', { baseUrl: tfc.url, organization: 'acme', token: 't' })).toHaveLength(101);
    expect(tfc.seen[0]!.url).toContain('/api/v2/organizations/acme/workspaces');
    await tfc.close();

    const jira = await api((req) => (req.url?.includes('nextPageToken=n1') ? { issues: [{ key: 'P-2' }] } : { issues: [{ key: 'P-1' }], nextPageToken: 'n1' }));
    const issues = await collect('jira', 'issue', { baseUrl: jira.url, email: 'e@x', token: 't', jql: 'project = P' });
    expect(issues).toEqual([{ key: 'P-1' }, { key: 'P-2' }]);
    expect(decodeURIComponent(jira.seen[0]!.url.replace(/\+/g, ' '))).toContain('jql=project = P');
    expect(jira.seen[0]!.headers.authorization).toMatch(/^Basic /);
    await jira.close();
  });
});
