import { evaluate, render } from '../lib/expr.js';
import { casesOf, type Step } from './workflow.js';
import { expandWorkflow, withParams } from './fragments.js';

/** Result of simulating one step against sample data. Nothing is executed or stored. */
export interface SimulatedStep {
  id: string;
  type: string;
  skipped: boolean;
  error?: string;
  /** Transform output, or the rendered configuration / message / prompt of other step types. */
  preview?: unknown;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Evaluate one expression against a sample context (used by the editor's "check" button). */
export async function previewExpression(expression: string, context: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  try {
    return { ok: true, value: await evaluate(expression, context) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/**
 * Walk the workflow in order with sample inputs: evaluate conditions and transforms, render templates
 * (secrets and env references are masked). Steps that call the outside world are not executed;
 * their output stays empty in the context.
 */
export async function simulateWorkflow(steps: Step[], base: { inputs?: unknown; entity?: unknown; vars?: unknown }): Promise<SimulatedStep[]> {
  const done: Record<string, { status: string; output: unknown; link: null }> = {};
  const out: SimulatedStep[] = [];
  const mask = async (kind: string, name: string) => `<${kind}:${name}>`;
  for (const s of (await expandWorkflow(steps)) as Step[]) {
    const ctx = await withParams(
      {
        run: { id: 'dry-run', url: '', idempotencyKey: 'dry-run', callback: { url: '', token: '' } },
        inputs: base.inputs ?? {},
        entity: base.entity ?? null,
        trigger: { user: { id: 'dry-run', email: '', name: 'Dry run' }, at: new Date().toISOString() },
        vars: base.vars ?? {},
        steps: done,
      },
      s,
    );
    // Branches not taken and failure handlers (nothing fails in a simulation) are skipped.
    const notTaken =
      casesOf(s).length > 0 && !casesOf(s).some((ref) => (done[ref.split('.')[0]]?.output as { case?: string } | null)?.case === ref.split('.')[1]);
    const r: SimulatedStep = { id: s.id, type: s.type, skipped: false };
    try {
      if (s.when === 'failure' || notTaken || (s.if && !(await evaluate(s.if, ctx)))) {
        r.skipped = true;
        done[s.id] = { status: 'SKIPPED', output: null, link: null };
      } else if (s.type === 'switch') {
        let chosen: string | null = null;
        for (const c of s.cases)
          if (await evaluate(c.when, ctx)) {
            chosen = c.id;
            break;
          }
        r.preview = { case: chosen ?? s.default ?? null };
        done[s.id] = { status: 'SUCCESS', output: r.preview, link: null };
      } else if (s.type === 'transform' && !s.forEach) {
        const output: Record<string, unknown> = {};
        for (const [k, expr] of Object.entries(s.output)) output[k] = await evaluate(expr, ctx);
        r.preview = output;
        done[s.id] = { status: 'SUCCESS', output, link: null };
      } else {
        const o = s as unknown as Record<string, unknown>;
        const template =
          s.type === 'invoke'
            ? s.invoker
            : s.type === 'approval'
              ? { message: s.message ?? '' }
              : { prompt: o.prompt ?? o.message ?? o.action ?? '', system: o.system ?? '' };
        r.preview = (await render(template, ctx, mask)).value;
        done[s.id] = { status: 'SUCCESS', output: null, link: null };
      }
    } catch (e) {
      r.error = errText(e);
    }
    out.push(r);
  }
  return out;
}
