import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api; // payments member, requester
let carol: Api; // platform member, approver
let ext: Awaited<ReturnType<typeof fakeServer>>;
let failuresLeft = 0;
const stops: (() => unknown)[] = [];

type RunView = {
  id: string;
  status: string;
  result: Record<string, unknown> | null;
  logs: { stepId: string | null; message: string }[];
  steps: { id: string; status: string; attempt: number; output: unknown; statusLabel: string | null; canApprove?: boolean; message: string | null }[];
};

const finished = (api: Api, id: string) =>
  waitFor(async () => {
    const r = (await api.get(`/api/v1/runs/${id}`)).data as RunView;
    return ['SUCCESS', 'FAILURE', 'CANCELLED', 'REJECTED'].includes(r.status) && r;
  }, 25_000);
const stepOf = (r: RunView, id: string) => r.steps.find((s) => s.id === id)!;
const save = async (id: string, body: object) => {
  const res = await admin.put(`/api/v1/actions/${id}`, { trigger: 'create', ...body }); // the form trigger, flat (legacy) form
  expect(res.status, JSON.stringify(res.data)).toBe(200);
};
const trigger = async (id: string, inputs: object = {}, api: Api = alice) => {
  const res = await api.post(`/api/v1/actions/${id}/runs`, { inputs });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.id as string;
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  const a = await register(app, 'alice@example.com');
  const c = await register(app, 'carol@example.com');
  alice = client(app, a.token);
  carol = client(app, c.token);
  await admin.put('/api/v1/teams/platform', { title: 'Platform' });
  await admin.patch(`/api/v1/users/${c.user.id}`, { teams: ['platform'] });
  await admin.put('/api/v1/blueprints/database', { title: 'Database', schema: { properties: { engine: { type: 'string' } } } });
  await admin.put('/api/v1/blueprints/database/entities/orders-db', { properties: { engine: 'postgres' } });
  ext = await fakeServer((r) => {
    if (r.url.startsWith('/flaky') && failuresLeft-- > 0) return { status: 503, body: { error: 'busy' } };
    if (r.url.startsWith('/fail')) return { status: 500, body: { error: 'boom' } };
    return { body: { received: JSON.parse(r.body || '{}') } };
  });
  stops.push(startRunWorker(silentLog));
});
afterAll(async () => {
  for (const s of stops) await s();
  await ext.close();
  await app.close();
});

describe('workflow definitions', () => {
  it('rejects broken graphs and expressions', async () => {
    const base = { title: 'X', blueprint: null, trigger: 'create' };
    const t = (id: string, extra: object = {}) => ({ id, type: 'transform', output: { v: '1' }, ...extra });
    expect((await admin.put('/api/v1/actions/x', { ...base, steps: [t('a'), t('a')] })).data.error).toMatch(/used twice/);
    expect((await admin.put('/api/v1/actions/x', { ...base, steps: [t('a', { needs: ['b'] }), t('b')] })).data.error).toMatch(/only name earlier steps/);
    expect((await admin.put('/api/v1/actions/x', { ...base, steps: [t('a', { if: 'inputs.(' })] })).data.error).toMatch(/Invalid expression/);
    expect((await admin.put('/api/v1/actions/x', { ...base, steps: [{ id: 'a', type: 'invoke', invoker: { type: 'webhook' } }] })).data.error).toMatch(
      /missing url/,
    );
    // A draft (no steps, or no trigger) saves but cannot run.
    expect((await admin.put('/api/v1/actions/x', { title: 'X', description: 'draft' })).data).toMatchObject({ trigger: null, steps: [] });
    expect((await alice.post('/api/v1/actions/x/runs', {})).data.error).toMatch(/no trigger yet/);
    expect((await admin.put('/api/v1/actions/x', { ...base })).status).toBe(200);
    expect((await alice.post('/api/v1/actions/x/runs', {})).data.error).toMatch(/no steps yet/);
    expect((await alice.get('/api/v1/actions?trigger=create')).data.find((a: { identifier: string }) => a.identifier === 'x').allowedForMe).toBe(false);
    // The nested form is the canonical one.
    const nested = await admin.put('/api/v1/actions/x', {
      title: 'X',
      trigger: { type: 'form', on: 'day-2', blueprint: 'database', inputs: { properties: { size: { type: 'integer' } } } },
      steps: [t('a')],
    });
    expect(nested.status, JSON.stringify(nested.data)).toBe(200);
    expect(nested.data.trigger).toMatchObject({ type: 'form', on: 'day-2', blueprint: 'database', approval: { required: false } });
    await admin.del('/api/v1/actions/x');
  });

  it('shows non-admins the shape of a workflow, not its configuration', async () => {
    await save('shape', {
      title: 'Shape',
      steps: [{ id: 'call', type: 'invoke', invoker: { type: 'webhook', url: 'https://secret.internal/x', headers: { a: '${secret:X}' } } }],
    });
    const seen = (await alice.get('/api/v1/actions/shape')).data;
    expect(seen.steps).toEqual([{ id: 'call', type: 'invoke', invoker: { type: 'webhook' } }]);
  });
});

describe('workflow execution', () => {
  it('runs steps in order, passes outputs along, skips on conditions and waits for a step approval', async () => {
    await save('provision', {
      title: 'Provision',
      inputs: { properties: { name: { type: 'string' }, size: { type: 'integer' } }, required: ['name', 'size'] },
      steps: [
        { id: 'plan', type: 'transform', output: { name: '$uppercase(inputs.name)', big: 'inputs.size > 100' } },
        { id: 'cheap_path', type: 'transform', if: '$not(steps.plan.output.big)', output: { note: '"small"' } },
        {
          id: 'review',
          name: 'Platform review',
          type: 'approval',
          if: 'steps.plan.output.big',
          approvers: { teams: ['platform'] },
          message: 'Provision **{{ steps.plan.output.name }}**?',
        },
        {
          id: 'call',
          type: 'invoke',
          invoker: { type: 'webhook', url: `${ext.url}/provision`, body: { name: '{{ steps.plan.output.name }}', approvedBy: '{{ steps.review.output.by }}' } },
        },
      ],
    });
    const id = await trigger('provision', { name: 'orders', size: 500 });
    const waiting = await waitFor(async () => {
      const r = (await carol.get(`/api/v1/runs/${id}`)).data as RunView;
      return stepOf(r, 'review')?.status === 'WAITING_APPROVAL' && r;
    });
    expect(stepOf(waiting, 'cheap_path').status).toBe('SKIPPED');
    expect(stepOf(waiting, 'review').message).toBe('Provision **ORDERS**?');
    expect(stepOf(waiting, 'review').canApprove).toBe(true);
    expect(stepOf((await alice.get(`/api/v1/runs/${id}`)).data as RunView, 'review').canApprove).toBe(false); // requester

    // The approvals queue shows the step to Carol, not to Alice.
    const queue = (await carol.get('/api/v1/approvals')).data as { id: string; pendingStep: { id: string } | null }[];
    expect(queue.find((q) => q.id === id)?.pendingStep?.id).toBe('review');
    expect(((await alice.get('/api/v1/approvals')).data as unknown[]).length).toBe(0);
    expect((await alice.post(`/api/v1/runs/${id}/steps/review/approve`, {})).status).toBe(403);

    expect((await carol.post(`/api/v1/runs/${id}/steps/review/approve`, { comment: 'ok' })).status).toBe(200);
    const done = await finished(alice, id);
    expect(done.status).toBe('SUCCESS');
    expect(stepOf(done, 'call').output).toEqual({ received: { name: 'ORDERS', approvedBy: ['carol'] } });
    expect(done.result).toMatchObject({ plan: { name: 'ORDERS', big: true }, review: { approved: true } });
    expect(done.logs.some((l) => l.stepId === 'review' && /Approved by carol/.test(l.message))).toBe(true);
  });

  it('runs parallel branches and joins them', async () => {
    await save('fanout', {
      title: 'Fan-out',
      steps: [
        { id: 'a', type: 'transform', needs: [], output: { v: '"A"' } },
        { id: 'b', type: 'transform', needs: [], output: { v: '"B"' } },
        { id: 'join', type: 'transform', needs: ['a', 'b'], output: { both: 'steps.a.output.v & steps.b.output.v' } },
      ],
    });
    const done = await finished(alice, await trigger('fanout'));
    expect(stepOf(done, 'join').output).toEqual({ both: 'AB' });
  });

  it('retries failed steps with backoff', async () => {
    failuresLeft = 2;
    await save('flaky', {
      title: 'Flaky',
      steps: [{ id: 'call', type: 'invoke', retries: 2, retryDelaySeconds: 1, invoker: { type: 'webhook', url: `${ext.url}/flaky` } }],
    });
    const done = await finished(alice, await trigger('flaky'));
    expect(done.status).toBe('SUCCESS');
    expect(stepOf(done, 'call').attempt).toBe(3);
    expect(done.logs.filter((l) => /Retrying in/.test(l.message))).toHaveLength(2);
  });

  it('continues past tolerated failures and skips dependents of real ones', async () => {
    await save('tolerant', {
      title: 'Tolerant',
      steps: [
        { id: 'notify', type: 'invoke', continueOnError: true, invoker: { type: 'webhook', url: `${ext.url}/fail` } },
        { id: 'after', type: 'transform', output: { ran: 'true' } },
      ],
    });
    const ok = await finished(alice, await trigger('tolerant'));
    expect(ok.status).toBe('SUCCESS');
    expect(stepOf(ok, 'notify').status).toBe('FAILURE');
    expect(stepOf(ok, 'after').status).toBe('SUCCESS');

    await save('strict', {
      title: 'Strict',
      steps: [
        { id: 'deploy', type: 'invoke', invoker: { type: 'webhook', url: `${ext.url}/fail` } },
        { id: 'smoke', type: 'transform', output: { ran: 'true' } },
        { id: 'audit', type: 'transform', needs: [], output: { ran: 'true' } },
      ],
    });
    const ko = await finished(alice, await trigger('strict'));
    expect(ko.status).toBe('FAILURE');
    expect(stepOf(ko, 'smoke').status).toBe('SKIPPED');
    expect(stepOf(ko, 'smoke').statusLabel).toMatch(/deploy did not succeed/);
    expect(stepOf(ko, 'audit').status).toBe('SUCCESS'); // independent branch
  });

  it('fails the workflow when an approval step is rejected, and cancels waiting steps', async () => {
    const gate = { id: 'gate', type: 'approval', approvers: { teams: ['platform'] } };
    await save('gated', { title: 'Gated', steps: [gate, { id: 'go', type: 'transform', output: { ran: 'true' } }] });
    const r1 = await trigger('gated');
    await waitFor(async () => stepOf((await carol.get(`/api/v1/runs/${r1}`)).data, 'gate')?.status === 'WAITING_APPROVAL');
    expect((await carol.post(`/api/v1/runs/${r1}/steps/gate/reject`, {})).status).toBe(400); // reason required
    await carol.post(`/api/v1/runs/${r1}/steps/gate/reject`, { comment: 'not this week' });
    const rejected = await finished(alice, r1);
    expect(rejected.status).toBe('FAILURE');
    expect(stepOf(rejected, 'go').status).toBe('SKIPPED');

    const r2 = await trigger('gated');
    await waitFor(async () => stepOf((await alice.get(`/api/v1/runs/${r2}`)).data, 'gate')?.status === 'WAITING_APPROVAL');
    expect((await alice.post(`/api/v1/runs/${r2}/cancel`, {})).data.status).toBe('CANCELLED');
    const cancelled = (await alice.get(`/api/v1/runs/${r2}`)).data as RunView;
    expect(cancelled.steps.map((s) => s.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });
});

describe('agent steps (Claude)', () => {
  let claude: Awaited<ReturnType<typeof fakeServer>>;
  const requests: Record<string, unknown>[] = [];

  beforeAll(async () => {
    // A fake Messages API: first a tool call to the catalog, then a structured answer.
    claude = await fakeServer((r) => {
      const body = JSON.parse(r.body) as { messages: unknown[] };
      requests.push(body);
      const turn = body.messages.length;
      const base = {
        id: `msg_${turn}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0 },
      };
      if (turn === 1)
        return {
          body: {
            ...base,
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'search_catalog', input: { query: 'orders', blueprint: 'database' } }],
          },
        };
      return {
        body: {
          ...base,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({ risk: 'high', summary: 'Production database growth', approve: false }) }],
        },
      };
    });
    process.env.ANTHROPIC_BASE_URL = claude.url;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  });
  afterAll(() => claude.close());

  it('calls Claude with tools and a JSON schema, and feeds the structured answer to later steps', async () => {
    await save('ai-review', {
      title: 'AI review',
      inputs: { properties: { name: { type: 'string' } } },
      steps: [
        {
          id: 'review',
          type: 'agent',
          tools: ['catalog'],
          system: 'You review infrastructure requests.',
          prompt: 'Assess the request for {{ inputs.name }} requested by {{ trigger.user.email }}.',
          output: {
            properties: {
              risk: { type: 'string', enum: ['low', 'medium', 'high'] },
              summary: { type: 'string', maxLength: 500 },
              approve: { type: 'boolean' },
            },
            required: ['risk', 'summary', 'approve'],
          },
        },
        { id: 'route', type: 'transform', output: { needsHuman: 'steps.review.output.risk != "low"' } },
      ],
    });
    const done = await finished(alice, await trigger('ai-review', { name: 'orders-db' }));
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    expect(stepOf(done, 'review').output).toEqual({ risk: 'high', summary: 'Production database growth', approve: false });
    expect(stepOf(done, 'route').output).toEqual({ needsHuman: true });

    const first = requests[0] as {
      model: string;
      system: string;
      messages: { content: string }[];
      output_config: Record<string, unknown>;
      tools: { name: string }[];
      fallbacks: string;
    };
    expect(first.model).toBe('claude-opus-5-5');
    expect(first.messages[0].content).toBe('Assess the request for orders-db requested by alice@example.com.');
    expect(first.tools.map((t) => t.name)).toEqual(['list_blueprints', 'search_catalog', 'get_entity']);
    expect(first.fallbacks).toBe('default');
    expect(first.output_config).toEqual({
      effort: 'medium',
      format: {
        type: 'json_schema',
        // Unsupported constraints (maxLength) are removed from the API schema and checked locally.
        schema: {
          type: 'object',
          properties: { risk: { type: 'string', enum: ['low', 'medium', 'high'] }, summary: { type: 'string' }, approve: { type: 'boolean' } },
          required: ['risk', 'summary', 'approve'],
          additionalProperties: false,
        },
      },
    });
    // The tool result carried real catalog data back to the model.
    const second = requests[1] as { messages: { role: string; content: { type: string; content: string }[] }[] };
    const toolResult = second.messages[2].content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.content).toContain('orders-db');
    expect(done.logs.some((l) => /2 turn\(s\): 2000 input \/ 400 output tokens · ≈ \$0\.0160/.test(l.message))).toBe(true);
  });

  it('fails without retrying when no API key is configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await save('ai-nokey', { title: 'No key', steps: [{ id: 'think', type: 'agent', retries: 3, prompt: 'Hello' }] });
    const done = await finished(alice, await trigger('ai-nokey'));
    expect(done.status).toBe('FAILURE');
    expect(stepOf(done, 'think').attempt).toBe(1);
    expect(stepOf(done, 'think').statusLabel).toMatch(/No Claude API key/);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  });
});

describe('azure pipelines and catalog cascade', () => {
  it('exposes the pipeline run as step output and deletes dependent entities with cascade', async () => {
    let polls = 0;
    const ado = await fakeServer((r) =>
      r.method === 'POST'
        ? { body: { id: 7, state: 'inProgress' } }
        : {
            body: polls++ ? { id: 7, state: 'completed', result: 'succeeded', _links: { web: { href: 'https://ado/run/7' } } } : { id: 7, state: 'inProgress' },
          },
    );
    await admin.put('/api/v1/blueprints/proj', { title: 'Project', schema: { properties: { url: { type: 'string' } } } });
    await admin.put('/api/v1/blueprints/repo', { title: 'Repo', schema: { properties: {} }, relations: { project: { target: 'proj' } } });
    await save('make-proj', {
      title: 'Make project',
      inputs: { properties: { name: { type: 'string' } } },
      steps: [
        {
          id: 'pipeline',
          type: 'invoke',
          invoker: {
            type: 'azure-pipeline',
            organization: `${ado.url}/org/`,
            project: 'Platform',
            pipelineId: 3,
            token: 'pat',
            templateParameters: { project: '{{ inputs.name }}' },
          },
        },
        {
          id: 'register',
          type: 'invoke',
          invoker: {
            type: 'catalog',
            blueprint: 'proj',
            identifier: '{{ inputs.name }}',
            properties: { url: '{{ steps.pipeline.output.organization }}/{{ inputs.name }}' },
          },
        },
      ],
    });
    const done = await finished(alice, await trigger('make-proj', { name: 'P1' }));
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    expect((done.result as Record<string, unknown>).pipeline).toEqual({
      runId: 7,
      result: 'succeeded',
      url: 'https://ado/run/7',
      organization: `${ado.url}/org`,
      project: 'Platform',
    });
    expect(JSON.parse(ado.received[0].body).templateParameters).toEqual({ project: 'P1' });
    expect((await admin.get('/api/v1/blueprints/proj/entities/P1')).data.properties.url).toBe(`${ado.url}/org/P1`);

    await admin.put('/api/v1/blueprints/repo/entities/r1', { relations: { project: 'P1' } });
    await admin.put('/api/v1/blueprints/repo/entities/r2', { relations: { project: 'P1' } });
    await save('drop-proj', {
      title: 'Drop',
      steps: [{ id: 'drop', type: 'invoke', invoker: { type: 'catalog', operation: 'delete', blueprint: 'proj', identifier: 'P1', cascade: true } }],
    });
    const dropped = await finished(alice, await trigger('drop-proj'));
    expect(dropped.status, JSON.stringify(dropped.logs)).toBe('SUCCESS');
    expect((dropped.result as { drop: { deleted: unknown[] } }).drop.deleted).toHaveLength(3);
    expect((await admin.get('/api/v1/blueprints/repo/entities/r1')).status).toBe(404);
    expect((await admin.get('/api/v1/blueprints/proj/entities/P1')).status).toBe(404);
    await ado.close();
  });
});
