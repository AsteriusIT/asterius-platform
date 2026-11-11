import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { getSource } from '../src/integrations/sources/index.js';
import { builtinConnectors } from '../src/integrations/connectors/definitions.js';
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

describe('built-in connector definitions as integration types (the former presets)', () => {
  it('every built-in definition ships a valid example; legacy inline configs still validate', () => {
    const defs = [...builtinConnectors().values()];
    expect(defs.map((d) => d.identifier)).toEqual(
      expect.arrayContaining([
        'argocd',
        'pagerduty',
        'opsgenie',
        'jira',
        'sonarqube',
        'nexus',
        'snyk',
        'terraform-cloud-workspaces',
        'okta',
        'entra-directory',
        'grafana',
        'datadog',
        'servicenow',
        'azure-devops',
        'github',
        'gitlab',
      ]),
    );
    for (const d of defs) {
      for (const m of d.example?.mappings ?? []) expect(Object.keys(d.kinds), d.identifier).toContain(m.kind);
      if (['azure-devops', 'github', 'gitlab'].includes(d.identifier)) continue; // code sources keep these types
      const src = getSource(d.identifier);
      expect(src.info.kinds).toEqual(Object.keys(d.kinds));
      expect(() => src.validate({ connection: 'x' }), d.identifier).not.toThrow();
    }
    expect(() => getSource('pagerduty').validate({})).toThrow(/token/);
    expect(() => getSource('pagerduty').validate({ token: 't' })).not.toThrow();
    expect(() => getSource('okta').validate({ token: 't' })).toThrow(/baseUrl/);
    expect(() => getSource('jira').validate({ baseUrl: 'https://x.test', email: 'e@x', token: 't' })).not.toThrow();
    expect(() => getSource('datadog').validate({ apiKey: 'a' })).toThrow(/appKey/);
    expect(() => getSource('entra-directory').validate({ auth: { type: 'bearer', token: 't' } })).not.toThrow();
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
  it('Datadog: two credential headers; SonarQube: the token as Basic username', async () => {
    const s = await api((req) => (req.url?.startsWith('/api/v1/monitor') ? [{ id: 1 }] : { components: [{ key: 'k' }], paging: { total: 1 } }));
    expect(await collect('datadog', 'monitor', { baseUrl: s.url, apiKey: 'ak', appKey: 'pk' })).toEqual([{ id: 1 }]);
    expect(s.seen[0]!.headers['dd-api-key']).toBe('ak');
    expect(s.seen[0]!.headers['dd-application-key']).toBe('pk');
    expect(await collect('sonarqube', 'project', { baseUrl: s.url, token: 'sq' })).toEqual([{ key: 'k' }]);
    expect(s.seen[1]!.headers.authorization).toBe(`Basic ${Buffer.from('sq:').toString('base64')}`);
    await s.close();
  });

  it('Nexus: basic auth, continuationToken paging, repository filter only when set', async () => {
    const s = await api((req) => {
      const q = new URL(req.url ?? '', 'http://x').searchParams;
      if (req.url?.startsWith('/service/rest/v1/repositories')) return [{ name: 'maven-releases', format: 'maven2' }];
      return q.get('continuationToken') ? { items: [{ id: 'c2' }], continuationToken: null } : { items: [{ id: 'c1' }], continuationToken: 'next' };
    });
    const config = { baseUrl: s.url, user: 'asterius', password: 'pw' };
    expect(await collect('nexus', 'repository', config)).toEqual([{ name: 'maven-releases', format: 'maven2' }]);
    expect(await collect('nexus', 'component', config)).toEqual([{ id: 'c1' }, { id: 'c2' }]);
    expect(s.seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from('asterius:pw').toString('base64')}`);
    expect(s.seen[1]!.url).toBe('/service/rest/v1/search'); // no empty repository= parameter
    expect(s.seen[2]!.url).toContain('continuationToken=next');
    await collect('nexus', 'component', { ...config, repository: 'npm-proxy' });
    expect(s.seen[4]!.url).toContain('repository=npm-proxy');
    await s.close();
  });
});
