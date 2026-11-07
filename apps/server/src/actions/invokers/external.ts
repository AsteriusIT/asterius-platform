import { z } from 'zod';
import { validateAuth } from '../../lib/auth.js';
import { http } from '../../lib/http.js';
import { requireFields, str, type InvokeEnv, type InvokeResult, type Invoker } from '../types.js';

/**
 * Out-of-process invoker: your service runs the action.
 *
 *   POST {url}/start   { config, run, action, inputs, entity, trigger, steps }
 *   POST {url}/poll    { config, state, run }       (while IN_PROGRESS)
 *   POST {url}/cancel  { config, state, run }       (optional)
 *   →  200 { status: "IN_PROGRESS" | "SUCCESS" | "FAILURE", state?, link?, statusLabel?, result? }
 *
 * `config` is the invoker configuration without `url`, `auth` and `headers`.
 */
const answer = z.object({
  status: z.enum(['IN_PROGRESS', 'SUCCESS', 'FAILURE']),
  state: z.record(z.string(), z.unknown()).optional(),
  link: z.string().optional(),
  statusLabel: z.string().optional(),
  result: z.unknown().optional(),
});

async function call(env: InvokeEnv, verb: 'start' | 'poll' | 'cancel', extra: Record<string, unknown>): Promise<InvokeResult> {
  const { url, headers, auth, ...rest } = env.config;
  const res = await http(`${str(url).replace(/\/$/, '')}/${verb}`, {
    method: 'POST',
    headers: (headers as Record<string, string>) ?? {},
    auth,
    body: { config: rest, run: env.ctx.run, ...extra },
  });
  if (verb === 'cancel') return { status: 'FAILURE' };
  const parsed = answer.safeParse(res.data);
  if (!parsed.success)
    throw new Error(`external invoker: invalid /${verb} response: ${parsed.error.issues[0]?.path.join('.') || 'body'} ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export const externalInvoker: Invoker = {
  info: {
    type: 'external',
    title: 'External plugin (HTTP)',
    description: 'Delegate the action to your own service over a small HTTP contract (start / poll / cancel).',
    fields: [
      { key: 'url', label: 'Plugin URL', kind: 'text', required: true, placeholder: 'https://asterius-plugin-jira.internal' },
      { key: 'headers', label: 'Headers', kind: 'keyvalue', help: 'e.g. Authorization: Bearer ${secret:TOKEN}' },
      { key: 'auth', label: 'Authentication', kind: 'json', advanced: true },
    ],
    example: {
      type: 'external',
      url: 'https://asterius-plugin-jira.internal',
      headers: { Authorization: 'Bearer ${secret:PLUGIN_TOKEN}' },
      project: 'PLAT',
      summary: '{{ inputs.title }}',
    },
  },
  validate(c) {
    requireFields(c, ['url'], 'external');
    validateAuth(c.auth);
  },
  start: (env) =>
    call(env, 'start', { action: env.ctx.action, inputs: env.ctx.inputs, entity: env.ctx.entity, trigger: env.ctx.trigger, steps: env.ctx.steps }),
  poll: (env, state) => call(env, 'poll', { state }),
  async cancel(env, state) {
    await call(env, 'cancel', { state });
  },
};
