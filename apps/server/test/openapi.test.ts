import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
});

describe('OpenAPI', () => {
  it('describes the routes and the resource schemas', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe('3.1.0');
    const put = spec.paths['/api/v1/integrations/{id}'].put;
    expect(put.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/Integration');
    expect(put.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
    expect(spec.components.schemas.Integration.properties).toHaveProperty('deleteMaxPercent');
    expect(spec.components.schemas.Webhook.properties).toHaveProperty('transform');
    // Inbound webhooks and auth are not part of the public contract.
    expect(Object.keys(spec.paths).some((p) => p.includes('/ingest/'))).toBe(false);
    const ids = Object.values(spec.paths).flatMap((ops) => Object.values(ops as Record<string, { operationId: string }>).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serves a reference page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/api/v1/blueprints');
  });
});
