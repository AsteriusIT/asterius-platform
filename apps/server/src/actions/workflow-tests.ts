import type { DryRunStep, ObjectSchema, WorkflowTestReport, WorkflowTestResult } from '@asterius/shared';
import { config } from '../config.js';
import { errorMessage, notFound } from '../lib/errors.js';
import { evaluate, type RefResolver } from '../lib/expr.js';
import { compact, validator } from '../catalog/validation.js';
import { findEntity } from '../catalog/entities.js';
import { actionDef, workflowTest, type WorkflowTestDef } from '../schemas.js';
import { getAction } from './actions.js';
import { simulate } from './dryrun.js';
import { isFormLike } from './trigger-defs.js';
import { needsOf, stepsOf, type Step } from './workflow.js';
import type { RunContext } from './types.js';
import type { FastifyBaseLogger } from 'fastify';
import { automationPrincipal } from '../auth/users.js';

/**
 * Workflow tests (`tests` of an action): each test simulates a run with the dry-run machinery and compares the result
 * with its expectations. Nothing is executed outside the platform and nothing is stored:
 *  - invoke, agent and workflow steps call the outside world (or another workflow): they MUST be mocked
 *    (`mocks.<step>: { status, output }`); an unmocked one fails the test. Their configuration is still rendered and
 *    validated, so template and invoker errors show up;
 *  - approval steps are approved (output `{ approved: true, … }`), wait steps resolve at once and input steps answer
 *    with sample values, unless mocked (a mocked FAILURE is a rejection / timeout);
 *  - transforms and conditions (`if`) are evaluated for real; `needs`, `continueOnError` and `outputSchema` behave as in
 *    a run (a failed dependency skips its dependents);
 *  - secret references resolve to a mask and are not looked up.
 * Expectations: `status` (default SUCCESS), per-step `status` and `output`, and the run `outputs` (outputs by step id).
 * `output` / `outputs` are partial matches: objects compare only the keys given, arrays element by element.
 */

type Who = { id: string; email: string; name: string };
type Diff = WorkflowTestResult['diffs'][number];
type StepOutcome = WorkflowTestResult['steps'][number];

const MASK = '********';
const EXTERNAL = new Set<Step['type']>(['invoke', 'agent', 'workflow']);

/** Partial deep match: objects compare the expected keys only, arrays need the same length, scalars strict equality. */
export function partialMatch(expected: unknown, actual: unknown, path: string, diffs: Diff[]) {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return void diffs.push({ path, expected, actual: actual ?? null });
    for (const [k, v] of Object.entries(expected)) partialMatch(v, (actual as Record<string, unknown>)[k], path ? `${path}.${k}` : k, diffs);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return void diffs.push({ path, expected, actual: actual ?? null });
    expected.forEach((v, i) => partialMatch(v, actual[i], `${path}[${i}]`, diffs));
    return;
  }
  if (expected !== actual) diffs.push({ path, expected, actual: actual ?? null });
}

/** Why a step output would be refused (size cap, `outputSchema`), like limits.outputProblem for real runs. */
function outputProblem(def: Step, output: unknown): string | null {
  const bytes = Buffer.byteLength(JSON.stringify(output) ?? '');
  if (bytes > config.STEP_OUTPUT_MAX_BYTES) return `Output too large: ${bytes} bytes (limit ${config.STEP_OUTPUT_MAX_BYTES})`;
  const schema = def.outputSchema;
  if (!schema || !Object.keys(schema.properties ?? {}).length) return null;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return 'Output does not match the step output schema: it is not an object';
  const check = validator(schema as never);
  if (check(output)) return null;
  return `Output does not match the step output schema: ${(check.errors ?? []).map((e) => `${e.instancePath || 'output'} ${e.message}`).join('; ')}`;
}

interface Workflow {
  identifier: string;
  title: string;
  trigger: ReturnType<typeof actionDef.parse>['trigger'];
  steps: Step[];
  tests: WorkflowTestDef[];
}

async function load(actionId: string, definition?: unknown): Promise<Workflow> {
  if (definition) {
    const def = actionDef.parse({ ...(definition as object), identifier: actionId });
    return { identifier: actionId, title: def.title, trigger: def.trigger, steps: stepsOf(def), tests: def.tests ?? [] };
  }
  const a = await getAction(actionId);
  return {
    identifier: a.identifier,
    title: a.title,
    trigger: a.trigger as Workflow['trigger'],
    steps: a.steps as Step[],
    // Stored tests were validated on save; parse again for the defaults (mock status, empty expectations).
    tests: (a.tests ?? []).map((t) => workflowTest.parse(t)),
  };
}

/** Run the tests of an action (all, or the one named `name`); `definition` tests an unsaved draft instead. */
export async function runWorkflowTests(actionId: string, who: Who, opts: { name?: string; definition?: unknown } = {}): Promise<WorkflowTestReport> {
  const wf = await load(actionId, opts.definition);
  const tests = opts.name ? wf.tests.filter((t) => t.name === opts.name) : wf.tests;
  if (opts.name && !tests.length) throw notFound(`Test "${opts.name}"`);
  const results: WorkflowTestResult[] = [];
  for (const t of tests) results.push(await runOne(wf, t, who));
  const passed = results.filter((r) => r.passed).length;
  return { passed, failed: results.length - passed, results };
}

async function runOne(wf: Workflow, t: WorkflowTestDef, who: Who): Promise<WorkflowTestResult> {
  const errors: string[] = [];
  const ids = new Set(wf.steps.map((s) => s.id));
  for (const id of Object.keys(t.mocks)) if (!ids.has(id)) errors.push(`mocks.${id}: no step "${id}" in this workflow`);
  for (const id of Object.keys(t.expect.steps ?? {})) if (!ids.has(id)) errors.push(`expect.steps.${id}: no step "${id}" in this workflow`);
  if (!wf.steps.length) errors.push('The workflow has no steps');

  const inputs = compact(t.inputs);
  if (isFormLike(wf.trigger)) {
    const v = validator(wf.trigger.inputs as ObjectSchema);
    if (!v(inputs))
      for (const e of v.errors ?? [])
        errors.push(
          `inputs: ${e.instancePath ? e.instancePath.slice(1) : ((e.params as { missingProperty?: string }).missingProperty ?? 'value')} ${e.message}`,
        );
  }
  const blueprint = wf.trigger && 'blueprint' in wf.trigger ? (wf.trigger.blueprint ?? null) : null;
  const entity = blueprint && t.entity ? ((await findEntity(blueprint, t.entity)) ?? null) : null;
  if (t.entity && !entity) errors.push(`entity: ${blueprint ?? '(no blueprint)'}/${t.entity} does not exist`);

  const resolver: RefResolver = async () => MASK;
  const ctx: RunContext = {
    run: {
      id: 'test-run',
      url: `${config.PUBLIC_URL}/runs/test-run`,
      idempotencyKey: 'test-run',
      callback: { url: `${config.PUBLIC_URL}/api/v1/runs/test-run/steps/<step>`, token: MASK },
    },
    action: { identifier: wf.identifier, title: wf.title, blueprint },
    inputs,
    entity,
    trigger: { user: { id: who.id, email: who.email, name: who.name }, at: new Date().toISOString() },
    steps: {},
  };

  const outcomes = new Map<string, StepOutcome & { blocked?: boolean }>();
  for (const [i, def] of wf.steps.entries()) {
    const set = (o: StepOutcome & { blocked?: boolean }) => {
      outcomes.set(def.id, o);
      ctx.steps[def.id] = { status: o.status, output: o.output, link: null };
    };
    const deps = needsOf(wf.steps, i).map((id) => ({ id, o: outcomes.get(id) }));
    const failed = deps.find(({ id, o }) => o && (o.blocked || (o.status === 'FAILURE' && !wf.steps.find((d) => d.id === id)?.continueOnError)));
    if (failed) {
      set({ id: def.id, status: 'SKIPPED', output: null, blocked: true });
      continue;
    }
    try {
      if (def.if && !(await evaluate(def.if, ctx))) {
        set({ id: def.id, status: 'SKIPPED', output: null });
        continue;
      }
    } catch (err) {
      set({ id: def.id, status: 'FAILURE', output: null, error: `Condition error: ${errorMessage(err)}` });
      continue;
    }
    const mock = t.mocks[def.id];
    if (!mock && EXTERNAL.has(def.type)) {
      errors.push(`Step "${def.id}" (${def.type}) calls the outside world: mock it (mocks.${def.id}: { status, output })`);
      set({ id: def.id, status: 'FAILURE', output: null, error: 'Not mocked' });
      continue;
    }
    try {
      const scratch: DryRunStep = { id: def.id, type: def.type, status: 'planned', errors: [] };
      const { output } = await simulate(def, ctx, resolver, mock?.status === 'SUCCESS' ? mock.output : undefined, scratch);
      if (scratch.errors.length) throw new Error(scratch.errors.join('; '));
      if (mock?.status === 'FAILURE') {
        set({ id: def.id, status: 'FAILURE', output: mock.output ?? null, error: 'Mocked failure' });
        continue;
      }
      const problem = outputProblem(def, output);
      if (problem) set({ id: def.id, status: 'FAILURE', output: null, error: problem });
      else set({ id: def.id, status: 'SUCCESS', output: output ?? null });
    } catch (err) {
      set({ id: def.id, status: 'FAILURE', output: null, error: errorMessage(err) });
    }
  }

  const steps = wf.steps.map((d) => {
    const { blocked: _blocked, ...o } = outcomes.get(d.id)!;
    return o;
  });
  const runFailed = steps.some((s) => s.status === 'FAILURE' && !wf.steps.find((d) => d.id === s.id)?.continueOnError);
  const status = runFailed ? 'FAILURE' : 'SUCCESS';
  const outputs = Object.fromEntries(steps.filter((s) => s.status === 'SUCCESS' && s.output != null).map((s) => [s.id, s.output]));

  const diffs: Diff[] = [];
  const expected = t.expect.status ?? 'SUCCESS';
  if (expected !== status) diffs.push({ path: 'status', expected, actual: status });
  for (const [id, e] of Object.entries(t.expect.steps ?? {})) {
    const got = steps.find((s) => s.id === id);
    if (!got) continue;
    if (e.status && e.status !== got.status) diffs.push({ path: `steps.${id}.status`, expected: e.status, actual: got.status });
    if (e.output !== undefined) partialMatch(e.output, got.output, `steps.${id}.output`, diffs);
  }
  if (t.expect.outputs) partialMatch(t.expect.outputs, outputs, 'outputs', diffs);
  return { name: t.name, passed: !errors.length && !diffs.length, status, steps, outputs, diffs, errors };
}

/** Configuration as code: run the tests of an action that was just applied and log the outcome (report only). */
export async function reportWorkflowTests(actionId: string, log: FastifyBaseLogger) {
  const report = await runWorkflowTests(actionId, await automationPrincipal());
  for (const r of report.results.filter((x) => !x.passed))
    log.warn({ component: 'config', action: actionId, test: r.name, errors: r.errors, diffs: r.diffs }, 'workflow test failed');
  if (report.results.length) log.info({ component: 'config', action: actionId, passed: report.passed, failed: report.failed }, 'workflow tests');
}
