import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { getSource } from '../src/integrations/sources/index.js';
import type { SourceEnv } from '../src/integrations/types.js';

async function api(handler: (req: IncomingMessage, body: string) => unknown) {
  const seen: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(handler(req, body)));
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => s.close(r)) };
}
async function collect(type: string, kind: string, config: Record<string, unknown>) {
  const env: SourceEnv = { config, log: () => undefined, startedAt: '', setState: () => undefined, incomplete: () => undefined };
  const out: unknown[] = [];
  for await (const page of getSource(type).list!(kind, env)) out.push(...page);
  return out;
}

describe('cloud sources', () => {
  it('aws-resources: Cloud Control paging with SigV4 and parsed properties', async () => {
    const s = await api((_r, body) =>
      JSON.parse(body).NextToken
        ? { ResourceDescriptions: [{ Identifier: 'b2', Properties: '{"BucketName":"b2"}' }] }
        : { ResourceDescriptions: [{ Identifier: 'b1', Properties: '{"BucketName":"b1"}' }], NextToken: 'n1' },
    );
    const items = await collect('aws-resources', 'AWS::S3::Bucket', { region: 'eu-west-1', endpoint: s.url, accessKeyId: 'AK', secretAccessKey: 'SK' });
    expect(items).toEqual([
      { identifier: 'b1', type: 'AWS::S3::Bucket', region: 'eu-west-1', properties: { BucketName: 'b1' } },
      { identifier: 'b2', type: 'AWS::S3::Bucket', region: 'eu-west-1', properties: { BucketName: 'b2' } },
    ]);
    expect(s.seen[0]!.headers['x-amz-target']).toBe('CloudApiService.ListResources');
    expect(s.seen[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/.*\/eu-west-1\/cloudcontrolapi\/aws4_request/);
    await expect(collect('aws-resources', 'bad kind', { region: 'x', endpoint: s.url })).rejects.toThrow(/resource type/);
    await s.close();
  });

  it('azure-resource-graph: KQL per kind with $skipToken paging', async () => {
    const s = await api((_r, body) => (JSON.parse(body).options.$skipToken ? { data: [{ name: 'vm2' }] } : { data: [{ name: 'vm1' }], $skipToken: 'tok' }));
    const items = await collect('azure-resource-graph', 'vm', {
      endpoint: s.url,
      queries: { vm: 'Resources | project name' },
      subscriptions: ['sub-1'],
      auth: { type: 'bearer', token: 'abc' },
    });
    expect(items).toEqual([{ name: 'vm1' }, { name: 'vm2' }]);
    expect(JSON.parse(s.seen[0]!.body)).toMatchObject({ query: 'Resources | project name', subscriptions: ['sub-1'] });
    expect(s.seen[0]!.headers.authorization).toBe('Bearer abc');
    await expect(collect('azure-resource-graph', 'other', { endpoint: s.url, queries: { vm: 'x' }, auth: { type: 'bearer', token: 'a' } })).rejects.toThrow(
      /no query/,
    );
    await s.close();
  });

  it('gcp-assets: pages assets of a type', async () => {
    const s = await api((r) => (r.url?.includes('pageToken=p2') ? { assets: [{ name: 'a2' }] } : { assets: [{ name: 'a1' }], nextPageToken: 'p2' }));
    const items = await collect('gcp-assets', 'run.googleapis.com/Service', { scope: 'projects/demo', endpoint: s.url, auth: { type: 'bearer', token: 't' } });
    expect(items).toEqual([{ name: 'a1' }, { name: 'a2' }]);
    expect(s.seen[0]!.url).toContain('/v1/projects/demo/assets?');
    expect(s.seen[0]!.url).toContain('assetTypes=run.googleapis.com%2FService');
    expect(() => getSource('gcp-assets').validate({ scope: 'bogus' })).toThrow(/scope/);
    await s.close();
  });
});
