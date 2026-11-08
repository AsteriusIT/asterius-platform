import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { batches, portalClient, sign, SIGNATURE_HEADER } from '../src/portal.ts';
import { logsEndpoint, occurrenceOf, toLogRecord } from '../src/otlp.ts';
import { Histogram, providerOf, Registry } from '../src/metrics.ts';
import { computeAll } from '../src/state.ts';
import { mr, xr } from './fixtures.ts';

/** The generic `signatureHeader` branch of the portal's verifyWebhook (apps/server/src/integrations/sync.ts). */
function portalVerifies(secret: string, header: string, raw: string) {
  const hex = createHmac('sha256', secret).update(raw).digest('hex');
  const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return eq(header, `sha256=${hex}`) || eq(header, hex);
}

describe('portal delivery', () => {
  it('signs the raw body the way the portal verifies it', () => {
    const body = JSON.stringify({ services: [] });
    assert.ok(portalVerifies('s3cret', sign('s3cret', body), body));
    assert.ok(!portalVerifies('other', sign('s3cret', body), body));
    assert.ok(!portalVerifies('s3cret', sign('s3cret', body), `${body} `));
  });

  it('posts signed batches with a delivery id to the default-organization route', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = portalClient({
      url: 'http://portal:8080/',
      secret: 'k',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('{}', { status: 202 });
      }) as typeof fetch,
    });
    const services = computeAll({ xrs: Array.from({ length: 150 }, (_, i) => xr(`s${i}`)), mrs: [], constraints: [], apps: [], compositions: new Map() });
    await client.send(services, 'full');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, 'http://portal:8080/api/v1/ingest/crossplane-watcher');
    const headers = calls[0]!.init.headers as Record<string, string>;
    const body = String(calls[0]!.init.body);
    assert.ok(portalVerifies('k', headers[SIGNATURE_HEADER]!, body));
    assert.notEqual(headers['x-asterius-delivery'], (calls[1]!.init.headers as Record<string, string>)['x-asterius-delivery']);
    const parsed = JSON.parse(body);
    assert.equal(parsed.source, 'crossplane-watcher');
    assert.equal(parsed.mode, 'full');
    assert.equal(parsed.services.length, 100);
    assert.ok(Date.parse(parsed.sentAt) > 0);
  });

  it('fails on a non-2xx answer (the watcher retries)', async () => {
    const client = portalClient({
      url: 'http://p',
      secret: 'k',
      org: 'acme',
      fetch: (async () => new Response('bad signature', { status: 401 })) as unknown as typeof fetch,
    });
    await assert.rejects(client.send(computeAll({ xrs: [xr('a')], mrs: [], constraints: [], apps: [], compositions: new Map() }), 'delta'), /401/);
  });

  it('splits batches', () => {
    assert.deepEqual(
      batches([1, 2, 3, 4, 5], 2).map((b) => b.length),
      [2, 2, 1],
    );
  });
});

describe('OTLP log records', () => {
  it('carries run_id, service, namespace, source and step (the MR kind)', () => {
    const rec = toLogRecord(
      {
        metadata: { name: 'e', namespace: 'team-payments', uid: 'u1' },
        involvedObject: { kind: 'Repository', apiVersion: 'azuredevops.upbound.io/v1alpha1', name: 'api', namespace: 'team-payments' },
        type: 'Warning',
        reason: 'CannotCreateExternalResource',
        message: 'quota',
        lastTimestamp: '2026-11-08T09:42:31Z',
      },
      { source: 'k8s_events', object: mr('Repository', 'api', 'api', { runId: 'r-8f2c' }) },
    );
    const a = Object.fromEntries(rec.attributes.map((x) => [x.key, x.value.stringValue]));
    assert.equal(a.run_id, 'r-8f2c');
    assert.equal(a.service, 'api');
    assert.equal(a.team, 'payments');
    assert.equal(a.namespace, 'team-payments');
    assert.equal(a.source, 'k8s_events');
    assert.equal(a.step, 'Repository');
    assert.equal(rec.severityText, 'WARN');
    assert.equal(rec.timeUnixNano, `${BigInt(Date.parse('2026-11-08T09:42:31Z')) * 1_000_000n}`);
    assert.equal(rec.body.stringValue, 'CannotCreateExternalResource: quota');
  });

  it('dedupes repeated events by occurrence', () => {
    const e = { metadata: { name: 'e', uid: 'u' }, count: 3 };
    assert.equal(occurrenceOf(e), 'u#3');
  });

  it('resolves the logs endpoint', () => {
    assert.equal(logsEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector.otel.svc:4318' }), 'http://otel-collector.otel.svc:4318/v1/logs');
    assert.equal(logsEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318/v1/logs' }), 'http://c:4318/v1/logs');
    assert.equal(logsEndpoint({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://l/x' }), 'http://l/x');
    assert.equal(logsEndpoint({}), undefined);
  });
});

describe('metrics', () => {
  it('renders histograms in the Prometheus text format', () => {
    const r = new Registry();
    const h = r.register(new Histogram('t_seconds', 'help', [60, 300]));
    h.observe({ golden_path: 'java-api', version: '3' }, 90);
    const text = r.render();
    assert.match(text, /# TYPE t_seconds histogram/);
    assert.match(text, /t_seconds_bucket\{golden_path="java-api",version="3",le="60"\} 0/);
    assert.match(text, /t_seconds_bucket\{golden_path="java-api",version="3",le="300"\} 1/);
    assert.match(text, /t_seconds_bucket\{golden_path="java-api",version="3",le="\+Inf"\} 1/);
    assert.match(text, /t_seconds_sum\{golden_path="java-api",version="3"\} 90/);
  });

  it('names the provider from the API group', () => {
    assert.equal(providerOf('project.azuredevops.upbound.io/v1alpha1'), 'azuredevops');
    assert.equal(providerOf('azuredevops.upbound.io/v1alpha1'), 'azuredevops');
    assert.equal(providerOf('repository.azuredevops.m.upbound.io/v1beta1'), 'azuredevops');
    assert.equal(providerOf('v1'), 'core');
  });
});
