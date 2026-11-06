import { evaluate, render } from '../lib/expr.js';
import type { Step } from './workflow.js';

/** Result of simulating one step against sample data. Nothing is executed or stored. */
export interface DryRunStep {
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
export async function dryRun(steps: Step[], base: { inputs?: unknown; entity?: unknown }): Promise<DryRunStep[]> {
  const done: Record<string, { status: string; output: unknown; link: null }> = {};
  const out: DryRunStep[] = [];
  const mask = async (kind: 'secret' | 'env', name: string) => `<${kind}:${name}>`;
  for (const s of steps) {
    const ctx = {
      run: { id: 'dry-run', url: '', callback: { url: '', token: '' } },
      inputs: base.inputs ?? {},
      entity: base.entity ?? null,
      trigger: { user: { id: 'dry-run', email: '', name: 'Dry run' }, at: new Date().toISOString() },
      steps: done,
    };
    const r: DryRunStep = { id: s.id, type: s.type, skipped: false };
    try {
      if (s.if && !(await evaluate(s.if, ctx))) {
        r.skipped = true;
        done[s.id] = { status: 'SKIPPED', output: null, link: null };
      } else if (s.type === 'transform') {
        const output: Record<string, unknown> = {};
        for (const [k, expr] of Object.entries(s.output)) output[k] = await evaluate(expr, ctx);
        r.preview = output;
        done[s.id] = { status: 'SUCCESS', output, link: null };
      } else {
        const template = s.type === 'invoke' ? s.invoker : s.type === 'approval' ? { message: s.message ?? '' } : { prompt: s.prompt, system: s.system ?? '' };
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
