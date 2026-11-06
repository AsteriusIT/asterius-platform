import { config } from '../config.js';
import { json } from '../db.js';
import { badRequest } from '../lib/errors.js';
import type { RefResolver } from '../lib/expr.js';
import { validator } from '../catalog/validation.js';
import { resolveRef } from '../secrets.js';
import { getRunRow, type RunRow } from './runs.js';
import { stepDefs } from './steps.js';

/**
 * Guard rails of workflows:
 *  - secret allow-list: a workflow may declare the `${secret:NAME}` / `${env:NAME}` references it is allowed to use
 *    (`secrets: [NAME, env:OTHER]`); anything else fails when saved and again when rendered;
 *  - step outputs are capped (STEP_OUTPUT_MAX_BYTES) and may declare a schema (`outputSchema`) they must satisfy.
 */

const REF = /\$\{(secret|env):([A-Za-z0-9_.-]+)\}/g;
const entryOf = (kind: string, name: string) => (kind === 'env' ? `env:${name}` : name);

/** Save time: every reference in the workflow must be in the allow-list (when there is one). */
export function assertSecretsAllowed(allowed: string[] | undefined | null, parts: unknown[]) {
  if (!allowed) return;
  const set = new Set(allowed);
  const text = JSON.stringify(parts);
  const bad = new Set<string>();
  for (const m of text.matchAll(REF)) if (!set.has(entryOf(m[1], m[2]))) bad.add(`\${${m[1]}:${m[2]}}`);
  if (bad.size) throw badRequest(`This workflow references secrets outside its allow-list (secrets): ${[...bad].join(', ')}`);
}

/** Run time: the resolver given to templates only resolves what the run's workflow allows. */
export function scopedResolver(allowed: string[] | undefined | null): RefResolver {
  if (!allowed) return resolveRef;
  const set = new Set(allowed);
  return async (kind, name) => {
    if (!set.has(entryOf(kind, name))) throw new Error(`\${${kind}:${name}} is not in this workflow's secret allow-list`);
    return resolveRef(kind, name);
  };
}

export const resolverFor = (r: Pick<RunRow, 'allowed_secrets'>) => scopedResolver(json<string[] | null>(r.allowed_secrets, null));

/** Why this output cannot be stored (too large, or not matching the step's output schema); null when fine. */
export async function outputProblem(runId: string, stepId: string, output: unknown): Promise<string | null> {
  const bytes = Buffer.byteLength(JSON.stringify(output) ?? '');
  if (bytes > config.STEP_OUTPUT_MAX_BYTES) return `Output too large: ${bytes} bytes (limit ${config.STEP_OUTPUT_MAX_BYTES})`;
  const def = stepDefs(await getRunRow(runId)).find((d) => d.id === stepId);
  const schema = def?.outputSchema;
  if (!schema || !Object.keys(schema.properties ?? {}).length) return null;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return 'Output does not match the step output schema: it is not an object';
  const check = validator(schema as never);
  if (check(output)) return null;
  const problems = (check.errors ?? []).map(
    (e) =>
      `${e.instancePath ? e.instancePath.slice(1).replaceAll('/', '.') : ((e.params as { missingProperty?: string }).missingProperty ?? 'output')}: ${e.message}`,
  );
  return `Output does not match the step output schema: ${problems.join('; ')}`.slice(0, 500);
}
