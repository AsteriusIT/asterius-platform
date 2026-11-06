import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, testApp, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let ext: Awaited<ReturnType<typeof fakeServer>>;

const form = { type: 'form', on: 'create', inputs: { properties: { name: { type: 'string' }, size: { type: 'integer' } }, required: ['name'] } };
type Result = {
  valid: boolean;
  inputErrors: string[];
  missingSecrets: string[];
  steps: { id: string; status: string; condition?: boolean; rendered: Record<string, unknown>; output: unknown; errors: string[] }[];
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  ext = await fakeServer();
  await admin.put('/api/v1/secrets/TOKEN', { value: 'super-secret-token', description: '' });
  await admin.put('/api/v1/actions/child', { title: 'Child', trigger: form, steps: [{ id: 't', type: 'transform', output: { v: '1' } }] });
  await admin.put('/api/v1/actions/plan', {
    title: 'Plan',
    trigger: form,
    steps: [
      { id: 'calc', type: 'transform', output: { host: '"db-" & inputs.name', big: 'inputs.size > 10' } },
      {
        id: 'call',
        type: 'invoke',
        if: 'steps.calc.output.big',
        invoker: { type: 'webhook', url: `${ext.url}/{{ steps.calc.output.host }}`, headers: { Authorization: 'Bearer ${secret:TOKEN}' } },
      },
      { id: 'note', type: 'transform', output: { who: 'trigger.user.name' } },
      { id: 'sub', type: 'workflow', action: 'child', inputs: { name: '{{ item }}' }, forEach: { items: '["a","b"]' } },
      { id: 'later', type: 'wait', until: '{{ steps.calc.output.host }}' },
    ],
  });
});
afterAll(async () => {
  await ext.close();
  await app.close();
});

describe('dry run', () => {
  it('renders the plan without calling anything and never reveals secrets', async () => {
    const res = await admin.post('/api/v1/actions/plan/dry-run', { inputs: { name: 'orders', size: 50 } });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const r = res.data as Result;
    expect(r.inputErrors).toEqual([]);
    const call = r.steps.find((s) => s.id === 'call')!;
    expect(call.status).toBe('planned');
    expect(call.rendered.url).toBe(`${ext.url}/db-orders`);
    expect((call.rendered.headers as Record<string, string>).Authorization).toBe('Bearer ********');
    expect(JSON.stringify(res.data)).not.toContain('super-secret-token');
    expect(r.steps.find((s) => s.id === 'sub')!.rendered).toMatchObject({ count: 2, children: [{ inputs: { name: 'a' } }, { inputs: { name: 'b' } }] });
    expect(ext.received).toHaveLength(0); // nothing was called
    // the date-time check of the wait step is reported
    expect(r.steps.find((s) => s.id === 'later')!.errors[0]).toMatch(/not a date-time/);
    expect(r.valid).toBe(false);
  });

  it('evaluates conditions and reports invalid inputs', async () => {
    const r = (await admin.post('/api/v1/actions/plan/dry-run', { inputs: { size: 3 } })).data as Result;
    expect(r.inputErrors.join()).toMatch(/name/);
    const call = r.steps.find((s) => s.id === 'call')!;
    expect(call).toMatchObject({ status: 'skipped', condition: false });
  });

  it('tests an unsaved definition, reports missing secrets and uses mocked outputs', async () => {
    const r = (
      await admin.post('/api/v1/actions/draft/dry-run', {
        definition: {
          title: 'Draft',
          trigger: form,
          steps: [
            { id: 'call', type: 'invoke', invoker: { type: 'webhook', url: `${ext.url}/x`, headers: { Authorization: 'Bearer ${secret:NOPE}' } } },
            { id: 'use', type: 'transform', output: { id: 'steps.call.output.id' } },
            { id: 'bad', type: 'invoke', invoker: { type: 'webhook' } },
          ],
        },
        inputs: { name: 'x' },
        mock: { call: { id: 'abc' } },
      })
    ).data as Result;
    expect(r.missingSecrets).toEqual(['${secret:NOPE}']);
    expect(r.steps.find((s) => s.id === 'use')!.output).toEqual({ id: 'abc' });
    expect(r.steps.find((s) => s.id === 'bad')).toMatchObject({ status: 'error' });
    expect(r.valid).toBe(false);
  });

  it('is limited to admins', async () => {
    expect((await alice.post('/api/v1/actions/plan/dry-run', {})).status).toBe(403);
    expect((await admin.post('/api/v1/actions/ghost/dry-run', {})).status).toBe(404);
  });
});
