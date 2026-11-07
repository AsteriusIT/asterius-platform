import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let bob: Api;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
});
afterAll(() => app.close());

describe('editor helpers', () => {
  it('lists the models in /api/meta', async () => {
    const meta = await client(app).get('/api/meta');
    expect(meta.data.models.map((m: { value: string }) => m.value)).toContain('claude-opus-5-5');
  });

  it('checks and previews expressions (admin only)', async () => {
    const ok = await admin.post('/api/v1/expressions/check', { expression: 'inputs.size * 2', context: { inputs: { size: 4 } } });
    expect(ok.data).toEqual({ ok: true, value: 8 });
    const bad = await admin.post('/api/v1/expressions/check', { expression: 'inputs.(' });
    expect(bad.data.ok).toBe(false);
    expect((await bob.post('/api/v1/expressions/check', { expression: '1' })).status).toBe(403);
  });

  it('dry-runs a workflow on sample inputs', async () => {
    const res = await admin.post('/api/v1/actions/dry-run', {
      inputs: { size: 3 },
      steps: [
        { id: 'calc', type: 'transform', output: { double: 'inputs.size * 2' } },
        { id: 'skipme', type: 'transform', if: 'steps.calc.output.double > 100', output: { x: '1' } },
        { id: 'ask', type: 'approval', message: 'Double is {{ steps.calc.output.double }}' },
      ],
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const [calc, skip, ask] = res.data.steps;
    expect(calc.preview).toEqual({ double: 6 });
    expect(skip.skipped).toBe(true);
    expect(ask.preview).toEqual({ message: 'Double is 6' });
  });
});
