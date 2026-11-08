import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { azurePipelinesInvoker, clearPipelineCache, pipelineRef, resolvePipelineId } from '../src/actions/invokers/azure-pipelines.js';
import type { InvokeEnv } from '../src/actions/types.js';
import { adoBuildOf, adoEvents, isTerminal } from '../src/v2/read/timeline.js';
import { schemaViolations, SCHEMA_POLICY } from '../src/v2/checks.js';
import { parseXrd } from '../src/v2/xrd.js';
import { checkNames, renderServiceSpec } from '../src/v2/spec.js';
import { SERVICE_MAX, TEAM_MAX } from '../src/v2/labels.js';
import { fakeAdoPipelines } from './v2-fake-pipelines.js';

/** V2 lean path building blocks (docs/V2-KIND.md): pipeline by name, ADO timeline, schema validation, name limits. */

describe('azure-pipeline: pipeline referenced by name', () => {
  let pipes: Awaited<ReturnType<typeof fakeAdoPipelines>>;
  beforeAll(async () => {
    pipes = await fakeAdoPipelines();
  });
  afterAll(async () => {
    await pipes.close();
  });
  const logs: string[] = [];
  const env = (config: Record<string, unknown>) =>
    ({
      ctx: {} as InvokeEnv['ctx'],
      config: { organization: pipes.org, project: 'Platform', token: 'pat', ...config },
      log: async (m: string) => void logs.push(m),
    }) as InvokeEnv;
  const lookups = () => pipes.calls.filter((c) => c.includes('/_apis/build/definitions?name=')).length;

  it('parses the reference: id, numeric string, name, folder\\name', () => {
    expect(pipelineRef({ pipelineId: 42 })).toEqual({ id: 42 });
    expect(pipelineRef({ pipelineId: '42' })).toEqual({ id: 42 });
    expect(pipelineRef({ pipeline: 'deploy' })).toEqual({ name: 'deploy' });
    expect(pipelineRef({ pipelineId: 'deploy' })).toEqual({ name: 'deploy' });
    expect(() => pipelineRef({})).toThrow(/pipelineId \(number\) or pipeline \(name\)/);
    expect(() => azurePipelinesInvoker.validate({ organization: 'o', project: 'p', token: 't' })).toThrow(/pipelineId \(or pipeline\)/);
    expect(() => azurePipelinesInvoker.validate({ organization: 'o', project: 'p', token: 't', pipeline: 'x' })).not.toThrow();
  });

  it('resolves a name once (cached), queues and follows the run; the output carries the pipeline id', async () => {
    clearPipelineCache();
    const start = await azurePipelinesInvoker.start(
      env({ pipeline: 'portal-services-apply', templateParameters: { service: 'a/b', runId: 'r1', operation: 'apply' } }),
    );
    expect(start).toMatchObject({ status: 'IN_PROGRESS', state: { pipelineId: 11 }, link: expect.stringContaining('_build/results?buildId=') });
    expect(pipes.runs.at(-1)).toMatchObject({ pipelineId: 11, templateParameters: { service: 'a/b', runId: 'r1', operation: 'apply' } });
    expect(await resolvePipelineId({ organization: pipes.org, project: 'Platform', token: 'pat', pipeline: 'Portal-Services-Apply' })).toBe(11);
    expect(lookups()).toBe(1);
    const done = await azurePipelinesInvoker.poll!(env({ pipeline: 'portal-services-apply', outputs: { artifact: 'outputs' } }), start.state!);
    expect(done.status).toBe('SUCCESS');
    expect(done.result).toMatchObject({
      result: 'succeeded',
      pipelineId: 11,
      project: 'Platform',
      outputs: { pipelineId: 77, projectUrl: expect.stringContaining('a-b') },
    });
    expect(lookups()).toBe(1); // poll uses the id kept in the step state
  });

  it('looks the name up again when the pipeline was recreated (404 on the cached id), and explains unknown names', async () => {
    pipes.definitions.Platform!['portal-operations'] = 12;
    await azurePipelinesInvoker.start(env({ pipeline: 'portal-operations' }));
    pipes.definitions.Platform!['portal-operations'] = 21; // deleted and recreated
    const again = await azurePipelinesInvoker.start(env({ pipeline: 'portal-operations' }));
    expect(again.state).toMatchObject({ pipelineId: 21 });
    await expect(azurePipelinesInvoker.start(env({ pipeline: 'nope' }))).rejects.toThrow(/no pipeline named "nope" in project Platform/);
  });

  it('a failed run is a FAILURE with its result (the V2 workflows record Degraded from it)', async () => {
    pipes.setOutcome(() => 'failed');
    const start = await azurePipelinesInvoker.start(env({ pipelineId: 11 }));
    const done = await azurePipelinesInvoker.poll!(env({ pipelineId: 11, logs: false }), start.state!);
    pipes.setOutcome(() => 'succeeded');
    expect(done).toMatchObject({ status: 'FAILURE', result: { result: 'failed', pipelineId: 11 } });
    expect((done.result as { outputs?: unknown }).outputs).toBeUndefined();
  });
});

describe('ADO build timeline → run timeline events', () => {
  it('parses the run link', () => {
    expect(adoBuildOf('https://dev.azure.com/AsteriusIT/Platform/_build/results?buildId=123')).toEqual({
      base: 'https://dev.azure.com/AsteriusIT/Platform',
      buildId: 123,
    });
    expect(adoBuildOf('https://dev.azure.com/AsteriusIT/Platform/_git/x')).toBeNull();
    expect(adoBuildOf(null)).toBeNull();
    expect(adoBuildOf('not a url')).toBeNull();
  });
  it('keeps stages, jobs and tasks that started; running ones at their start, finished ones at their end', () => {
    const e = adoEvents('Apply', [
      { type: 'Stage', name: 'apply', state: 'inProgress', startTime: '2026-11-08T10:00:00Z' },
      {
        type: 'Task',
        name: 'tofu apply',
        state: 'completed',
        result: 'failed',
        startTime: '2026-11-08T10:00:05Z',
        finishTime: '2026-11-08T10:00:35Z',
        issues: [{ type: 'error', message: 'boom' }],
      },
      { type: 'Task', name: 'skipped one', state: 'completed', result: 'skipped', startTime: '2026-11-08T10:00:01Z', finishTime: '2026-11-08T10:00:01Z' },
      { type: 'Checkpoint', name: 'cp', state: 'completed', result: 'succeeded', startTime: '2026-11-08T10:00:00Z', finishTime: '2026-11-08T10:00:00Z' },
      { type: 'Job', name: 'later', state: 'pending' },
    ]);
    expect(e).toEqual([
      { time: '2026-11-08T10:00:00Z', step: 'Stage apply', status: 'running', symbol: '…', source: 'ado', message: 'Apply · running' },
      { time: '2026-11-08T10:00:35Z', step: 'Task tofu apply', status: 'failure', symbol: '✗', source: 'ado', message: 'Apply · failed · 30s · boom' },
    ]);
  });
  it('a pipeline-driven Degraded is final once settled (no watcher will change it)', () => {
    const r = { id: 'r1', status: 'FAILURE' as const, createdAt: '2026-11-08T10:00:00Z', endedAt: '2026-11-08T10:05:00Z' };
    const e = { properties: { lifecycle: 'Degraded', lastRunId: 'r1' }, updatedAt: '2026-11-08T10:05:00Z' };
    const at = Date.parse('2026-11-08T10:07:00Z');
    expect(isTerminal(r, e, at)).toBe(false);
    expect(isTerminal(r, e, at, true)).toBe(true);
  });
});

describe('Service schema and name limits', () => {
  const plain = `openAPIV3Schema:
  type: object
  properties:
    spec:
      type: object
      required: [owner, environments]
      properties:
        owner: { type: string, pattern: "^[a-z][a-z0-9-]{1,19}$", maxLength: 20 }
        environments: { type: array, maxItems: 3, x-kubernetes-list-type: set, items: { type: string, enum: [dev, staging, prod] } }
        costCenter: { type: string, maxLength: 16 }
`;
  it('reads a plain schema file as well as an XRD', () => {
    expect(parseXrd(plain).spec.required).toEqual(['owner', 'environments']);
    expect(parseXrd(`properties:\n  spec: { type: object, properties: { a: { type: string } } }\nversion: v2\n`)).toMatchObject({
      version: 'v2',
      spec: { type: 'object' },
    });
    expect(() => parseXrd('kind: Something\n')).toThrow(/no CompositeResourceDefinition/);
  });
  it('validates the spec (Kubernetes extensions ignored), one violation per problem', () => {
    const spec = parseXrd(plain).spec;
    const m = renderServiceSpec({
      team: 'payments',
      service: 'api',
      inputs: { goldenPath: 'java-api', goldenPathVersion: '3', environments: ['dev'] },
      runId: 'r',
      requestedBy: 'x',
    });
    expect(schemaViolations(spec, m)).toEqual([]);
    const bad = { ...m, spec: { ...m.spec, environments: ['dev', 'qa'], costCenter: 'CC-12345678901234567' } };
    expect(schemaViolations(spec, bad).map((v) => [v.policy, v.msg])).toEqual([
      [SCHEMA_POLICY, 'spec.environments.1: must be equal to one of the allowed values (dev, staging, prod)'],
      [SCHEMA_POLICY, 'spec.costCenter: must NOT have more than 16 characters'],
    ]);
    expect(schemaViolations(spec, { ...m, spec: { environments: ['dev'] } })[0]!.msg).toBe("spec.owner: must have required property 'owner'");
  });
  it('team ≤ 20 and service ≤ 30 characters, DNS labels starting with a letter', () => {
    expect(TEAM_MAX).toBe(20);
    expect(SERVICE_MAX).toBe(30);
    expect(() => checkNames('t'.repeat(20), 's'.repeat(30))).not.toThrow();
    expect(() => checkNames('t'.repeat(21), 'svc')).toThrow(/team .*2–20/);
    expect(() => checkNames('team', 's'.repeat(31))).toThrow(/service .*2–30/);
    expect(() => checkNames('1team', 'svc')).toThrow(/team/);
    expect(() => checkNames('team-', 'svc')).toThrow(/team/);
    expect(() => checkNames('team', 'svc-')).toThrow(/service/);
    expect(() => checkNames('t', 'svc')).toThrow(/team/);
  });
});
