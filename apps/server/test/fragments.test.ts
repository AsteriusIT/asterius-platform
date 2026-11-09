import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, inDefaultOrg, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { config } from '../src/config.js';
import { checkAllConfig } from '../src/config-loader.js';
import { startRunWorker } from '../src/actions/worker.js';
import { expandSteps, type FragmentLookup } from '../src/actions/fragments.js';
import { fragmentDef, workflowStep } from '../src/schemas.js';
import type { Step } from '../src/actions/workflow.js';

let app: FastifyInstance;
let admin: Api;
let bob: Api;
let acme: Api;
const stops: (() => unknown)[] = [];

type RunView = {
  id: string;
  status: string;
  result: Record<string, unknown> | null;
  steps: { id: string; status: string; output: unknown; needs: string[]; fragment?: string }[];
};

const finished = (id: string) =>
  waitFor(async () => {
    const r = (await admin.get(`/api/v1/runs/${id}`)).data as RunView;
    return ['SUCCESS', 'FAILURE', 'CANCELLED'].includes(r.status) && r;
  }, 25_000);

/** A fragment computing a greeting from its parameters, in two steps. */
const greet = {
  title: 'Greet',
  params: { properties: { who: { type: 'string' }, times: { type: 'integer', default: 2 } }, required: ['who'] },
  steps: [
    { id: 'hello', type: 'transform', output: { text: '"hello " & params.who' } },
    { id: 'repeat', type: 'transform', output: { n: 'params.times', text: 'steps.hello.output.text' } },
  ],
  outputs: { message: 'steps.repeat.output.text & " x" & $string(steps.repeat.output.n)' },
};

const action = (steps: object[], extra: object = {}) => ({
  title: 'Uses fragment',
  trigger: { type: 'api', inputs: { properties: { name: { type: 'string' } } } },
  steps,
  ...extra,
});
const save = async (id: string, body: object) => {
  const res = await admin.put(`/api/v1/actions/${id}`, body);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  return res.data;
};
const trigger = async (id: string, inputs: object = {}) => {
  const res = await admin.post(`/api/v1/actions/${id}/runs`, { inputs });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.id as string;
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
  const carol = (await register(app, 'carol@example.com')).token;
  expect((await client(app, carol).post('/api/orgs', { slug: 'acme', name: 'Acme' })).status).toBe(201);
  acme = client(app, carol, 'acme');
  stops.push(startRunWorker(silentLog));
});
afterAll(async () => {
  for (const s of stops) await s();
  await app.close();
});

describe('fragment definitions', () => {
  it('CRUD: admin only, validated, versioned, audited, per organization', async () => {
    expect((await bob.put('/api/v1/fragments/greet', greet)).status).toBe(403);
    expect((await bob.get('/api/v1/fragments')).status).toBe(403);
    const created = await admin.put('/api/v1/fragments/greet', greet);
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    expect(created.data).toMatchObject({ identifier: 'greet', version: 1, managed: false, outputs: { message: expect.any(String) } });
    // Unchanged: same version; changed: next version.
    expect((await admin.put('/api/v1/fragments/greet', greet)).data.version).toBe(1);
    expect((await admin.put('/api/v1/fragments/greet', { ...greet, description: 'Says hello' })).data.version).toBe(2);
    expect((await admin.get('/api/v1/fragments/greet/versions')).data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await admin.get('/api/v1/fragments')).data.map((f: { identifier: string }) => f.identifier)).toContain('greet');
    const audit = (await admin.get('/api/v1/audit?action=fragment.updated')).data as { target: string }[];
    expect(audit.some((a) => a.target === 'greet')).toBe(true);
    expect((await acme.get('/api/v1/fragments/greet')).status).toBe(404);

    // Validation: graph, expressions, undeclared params, unknown nested fragments, cycles.
    const bad = (body: object) => admin.put('/api/v1/fragments/bad', { ...greet, ...body });
    expect((await bad({ steps: [] })).status).toBe(400);
    expect((await bad({ outputs: { x: 'a +' } })).data.error).toMatch(/Output x/);
    expect((await bad({ steps: [{ id: 'a', type: 'transform', output: { v: 'params.nope' } }] })).data.error).toMatch(/params\.nope/);
    expect((await bad({ steps: [{ id: 'a', type: 'fragment', fragment: 'missing' }] })).data.error).toMatch(/unknown fragment "missing"/);
    expect((await bad({ steps: [{ id: 'a', type: 'fragment', fragment: 'bad' }] })).data.error).toMatch(/cannot include itself/);
    expect((await admin.get('/api/v1/fragments/bad')).status).toBe(404);
  });

  it('managed when declared in CONFIG_DIR, removed when undeclared', async () => {
    const file = path.join(config.CONFIG_DIR, 'fragments-test.yaml');
    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      file,
      ['fragments:', '  - identifier: from-file', '    title: From file', '    steps:', '      - { id: one, type: transform, output: { v: "1" } }', ''].join(
        '\n',
      ),
    );
    try {
      await checkAllConfig(silentLog);
      expect((await admin.get('/api/v1/fragments/from-file')).data).toMatchObject({ managed: true, version: 1 });
      expect((await admin.put('/api/v1/fragments/from-file', { title: 'X', steps: [{ id: 'a', type: 'transform', output: {} }] })).status).toBe(409);
      expect((await admin.del('/api/v1/fragments/from-file')).status).toBe(409);
    } finally {
      fs.rmSync(file, { force: true });
    }
    await checkAllConfig(silentLog);
    expect((await admin.get('/api/v1/fragments/from-file')).status).toBe(404);
  });
});

describe('expansion', () => {
  const lookup =
    (defs: Record<string, object>): FragmentLookup =>
    async (id) =>
      defs[id] ? { def: fragmentDef.parse({ identifier: id, ...defs[id] }), version: 7 } : undefined;
  const steps = (list: object[]) => list.map((s) => workflowStep.parse(s)) as Step[];

  it('prefixes ids, rewires needs and references, adds the output step and gates on the condition', async () => {
    const out = await inDefaultOrg(() =>
      expandSteps(
        steps([
          { id: 'before', type: 'transform', output: { v: '1' } },
          { id: 'g', type: 'fragment', fragment: 'greet', with: { who: '{{ inputs.name }}' }, if: 'inputs.go' },
          { id: 'after', type: 'transform', output: { m: 'steps.g.output.message' } },
        ]),
        lookup({ greet }),
      ),
    );
    expect(out.map((s) => s.id)).toEqual(['before', 'g__hello', 'g__repeat', 'g', 'after']);
    const by = Object.fromEntries(out.map((s) => [s.id, s]));
    expect(by.g__hello.needs).toEqual(['before']); // entry step: what the fragment step waited for
    expect(by.g__repeat.needs).toEqual(['g__hello']);
    expect(by.g.needs).toEqual(['g__repeat']); // output step: the exit steps
    expect(by.after.needs).toEqual(['g']);
    expect(JSON.stringify(by.g__repeat)).toContain('steps.g__hello.output.text');
    expect(by.g).toMatchObject({ type: 'transform', output: { message: expect.stringContaining('steps.g__repeat.output') } });
    expect(by.g__hello.if).toBe('inputs.go');
    expect(by.g__hello.fragmentOf).toMatchObject({ root: 'g', fragment: 'greet', version: 7, params: [{ who: '{{ inputs.name }}', times: 2 }] });
  });

  it('nests up to three levels and rejects deeper ones and long ids', async () => {
    const leaf = { title: 'Leaf', steps: [{ id: 'x', type: 'transform', output: { v: '1' } }] };
    const wrap = (inner: string) => ({ title: 'Wrap', steps: [{ id: 'w', type: 'fragment', fragment: inner }] });
    const defs = { leaf, l2: wrap('leaf'), l3: wrap('l2'), l4: wrap('l3') };
    const ok = await inDefaultOrg(() => expandSteps(steps([{ id: 'a', type: 'fragment', fragment: 'l3' }]), lookup(defs)));
    expect(ok.map((s) => s.id)).toEqual(['a__w__w__x', 'a__w__w', 'a__w', 'a']);
    expect(ok[0].fragmentOf).toMatchObject({ root: 'a', step: 'a__w__w', fragment: 'leaf' });
    await expect(inDefaultOrg(() => expandSteps(steps([{ id: 'a', type: 'fragment', fragment: 'l4' }]), lookup(defs)))).rejects.toThrow(/3 levels/);
    await expect(inDefaultOrg(() => expandSteps(steps([{ id: `a${'b'.repeat(39)}`, type: 'fragment', fragment: 'leaf' }]), lookup(defs)))).rejects.toThrow(
      /too long/,
    );
  });
});

describe('workflows using fragments', () => {
  it('rejects unknown fragments, bad parameters and secrets outside the allow-list at save time', async () => {
    const put = (steps: object[], extra: object = {}) => admin.put('/api/v1/actions/frag-bad', action(steps, extra));
    expect((await put([{ id: 'g', type: 'fragment', fragment: 'nope' }])).data.error).toMatch(/unknown fragment "nope"/);
    expect((await put([{ id: 'g', type: 'fragment', fragment: 'greet' }])).data.error).toMatch(/missing required parameter "who"/);
    expect((await put([{ id: 'g', type: 'fragment', fragment: 'greet', with: { who: 'x', extra: 1 } }])).data.error).toMatch(/unknown parameter "extra"/);
    expect((await put([{ id: 'g', type: 'fragment', fragment: 'greet', with: { who: 'x', times: 'many' } }])).data.error).toMatch(/must be integer/);
    expect((await put([{ id: 'g', type: 'fragment', fragment: 'greet', with: { who: '${secret:TOKEN}' } }])).data.error).toMatch(/cannot reference secrets/);
    expect(
      (
        await put([
          { id: 'g__hello', type: 'transform', output: {} },
          { id: 'g', type: 'fragment', fragment: 'greet', with: { who: 'x' } },
        ])
      ).data.error,
    ).toMatch(/used twice/);
    // The fragment's own secret references count against the workflow's allow-list.
    await admin.put('/api/v1/fragments/secretive', {
      title: 'Secretive',
      steps: [{ id: 'call', type: 'invoke', invoker: { type: 'webhook', url: 'https://example.com', headers: { Authorization: '${secret:TOKEN}' } } }],
    });
    expect((await put([{ id: 's', type: 'fragment', fragment: 'secretive' }], { secrets: ['OTHER'] })).data.error).toMatch(/allow-list.*TOKEN/);
    expect((await put([{ id: 's', type: 'fragment', fragment: 'secretive' }], { secrets: ['TOKEN'] })).status).toBe(200);
    // Changing the fragment so that a workflow using it breaks is refused.
    const change = await admin.put('/api/v1/fragments/secretive', {
      title: 'Secretive',
      steps: [{ id: 'call', type: 'invoke', invoker: { type: 'webhook', url: 'https://example.com', headers: { Authorization: '${secret:OTHER}' } } }],
    });
    expect(change.status).toBe(400);
    expect(change.data.error).toMatch(/frag-bad/);
  });

  it('runs the inlined steps with params and outputs; the snapshot is unaffected by later edits', async () => {
    await save(
      'frag-run',
      action([
        { id: 'g', type: 'fragment', fragment: 'greet', with: { who: '{{ inputs.name }}' } },
        { id: 'after', type: 'transform', output: { m: 'steps.g.output.message' } },
      ]),
    );
    const id = await trigger('frag-run', { name: 'ada' });
    // Edit the fragment while (or after) the run exists: the run keeps its inlined copy.
    expect((await admin.put('/api/v1/fragments/greet', { ...greet, outputs: { message: '"changed"' } })).status).toBe(200);
    const r = await finished(id);
    expect(r.status).toBe('SUCCESS');
    expect(r.steps.map((s) => s.id)).toEqual(['g__hello', 'g__repeat', 'g', 'after']);
    expect(r.steps.find((s) => s.id === 'g__hello')).toMatchObject({ fragment: 'g', output: { text: 'hello ada' } });
    expect(r.steps.find((s) => s.id === 'g')!.output).toEqual({ message: 'hello ada x2' });
    expect(r.steps.find((s) => s.id === 'after')!.output).toEqual({ m: 'hello ada x2' });
    // A new run picks the change up.
    const next = await finished(await trigger('frag-run', { name: 'bob' }));
    expect(next.steps.find((s) => s.id === 'after')!.output).toEqual({ m: 'changed' });
    await admin.put('/api/v1/fragments/greet', greet);
  });

  it('skips the whole fragment when its condition is false', async () => {
    await save(
      'frag-if',
      action([
        { id: 'g', type: 'fragment', fragment: 'greet', with: { who: 'x' }, if: 'inputs.name = "go"' },
        { id: 'after', type: 'transform', output: { v: '1' } },
      ]),
    );
    const r = await finished(await trigger('frag-if', { name: 'stop' }));
    expect(r.status).toBe('SUCCESS');
    for (const id of ['g__hello', 'g__repeat', 'g']) expect(r.steps.find((s) => s.id === id)!.status).toBe('SKIPPED');
    expect(r.steps.find((s) => s.id === 'after')!.status).toBe('SUCCESS');
  });

  it('refuses to delete a fragment in use (409 naming the users)', async () => {
    const res = await admin.del('/api/v1/fragments/greet');
    expect(res.status).toBe(409);
    expect(res.data.usedBy.actions).toEqual(expect.arrayContaining(['frag-run', 'frag-if']));
    expect((await admin.get('/api/v1/fragments/greet/usage')).data.actions).toContain('frag-run');
    for (const a of ['frag-run', 'frag-if']) expect((await admin.del(`/api/v1/actions/${a}`)).status).toBe(200);
    expect((await admin.del('/api/v1/fragments/greet')).status).toBe(200);
    expect((await admin.get('/api/v1/fragments/greet')).status).toBe(404);
  });

  it('the demo configuration includes its approval fragment', async () => {
    const { readConfigDir } = await import('../src/config-loader.js');
    const { data } = readConfigDir(path.resolve(__dirname, '../../../examples/demo-config'));
    const defs = Object.fromEntries(data.fragments.map((f) => [f.identifier, f]));
    const action = data.actions.find((a) => a.identifier === 'provision-database')!;
    const out = await inDefaultOrg(() => expandSteps(action.steps, async (id) => (defs[id] ? { def: defs[id], version: 1 } : undefined)));
    expect(out.map((s) => s.id)).toEqual(['review', 'approval__approve', 'approval__record', 'approval', 'register']);
    expect(out.find((s) => s.id === 'register')!.needs).toEqual(['approval']);
  });
});
