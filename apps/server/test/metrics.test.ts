import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApp } from './helpers.js';
import { registry, metrics } from '../src/metrics.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});
afterAll(() => app.close());

describe('metrics', () => {
  it('records HTTP requests by route pattern, not raw URL', async () => {
    await app.inject({ url: '/api/v1/blueprints/some-unknown-id' });
    await app.inject({ url: '/api/v1/blueprints/another-id' });
    const text = await registry.metrics();
    expect(text).toMatch(/asterius_http_request_duration_seconds_count\{[^}]*route="\/api\/v1\/blueprints\/:[A-Za-z]+"/);
    expect(text).not.toContain('some-unknown-id');
  });

  it('exposes freshness, pool and upstream metrics', async () => {
    metrics.upstream('api.github.com', 429);
    metrics.deliveryLatency(1.5);
    metrics.sync('x', 'success', 0, 0, 2);
    const text = await registry.metrics();
    expect(text).toContain('asterius_upstream_rate_limited_total{host="api.github.com"} 1');
    expect(text).toContain('asterius_db_pool_waiting_requests');
    expect(text).toContain('asterius_integration_last_success_timestamp_seconds');
    expect(text).toContain('asterius_sync_duration_seconds_count{integration="x"} 1');
    expect(text).toContain('asterius_webhook_delivery_latency_seconds_count 1');
  });
});
