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
    const ok = spec.paths['/api/v1/integrations'].get.responses['200'].content['application/json'].schema;
    expect(ok).toEqual({ type: 'array', items: { $ref: '#/components/schemas/IntegrationView' } });
    expect(spec.components.schemas.IntegrationView.properties).toHaveProperty('lastSuccessAt');
    expect(JSON.stringify(spec)).not.toContain('#/$defs');
    // Inbound webhooks and auth are not part of the public contract.
    expect(Object.keys(spec.paths).some((p) => p.includes('/ingest/'))).toBe(false);
    const ids = Object.values(spec.paths).flatMap((ops) => Object.values(ops as Record<string, { operationId: string }>).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('documents the entity docs, related, graph, insights and policy routes', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json();
    const schemaOf = (p: string) => spec.paths[p].get.responses['200'].content['application/json'].schema.$ref;
    expect(schemaOf('/api/v1/blueprints/{bp}/entities/{id}/docs')).toBe('#/components/schemas/EntityDocs');
    expect(schemaOf('/api/v1/blueprints/{bp}/entities/{id}/related')).toBe('#/components/schemas/RelatedEntities');
    expect(schemaOf('/api/v1/blueprints/{bp}/entities/{id}/graph')).toBe('#/components/schemas/EntityGraph');
    expect(schemaOf('/api/v1/entities/{bp}/{id}/graph')).toBe('#/components/schemas/EntityGraph');
    expect(schemaOf('/api/v1/insights')).toBe('#/components/schemas/Insights');
    expect(schemaOf('/api/v1/policies')).toBeUndefined();
    expect(spec.paths['/api/v1/policies'].get.responses['200'].content['application/json'].schema.items.$ref).toBe('#/components/schemas/PolicyView');
    const names = (p: string) => spec.paths[p].get.parameters.map((x: { name: string }) => x.name);
    expect(names('/api/v1/insights')).toEqual(['days', 'team', 'service', 'deploymentBlueprint', 'incidentBlueprint', 'deploymentActions']);
    expect(names('/api/v1/blueprints/{bp}/entities/{id}/docs')).toEqual(['bp', 'id', 'property']);
    expect(spec.components.schemas.Insights.properties).toHaveProperty('mttr');
    expect(spec.components.schemas.EntityDocs.required).toEqual(['property', 'url', 'markdown']);
    // Every $ref resolves.
    const refs = [...JSON.stringify(spec).matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
    for (const r of refs) expect(spec.components.schemas).toHaveProperty(r);
  });

  it('serves a reference page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/api/v1/blueprints');
  });
});
