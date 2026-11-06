import { createHmac } from 'node:crypto';
import { http } from '../../lib/http.js';
import { requireFields, str, type Invoker } from '../types.js';

/**
 * Generic HTTP call: the integration point for custom services.
 *  - mode `sync`: the action succeeds when the endpoint answers 2xx (its JSON body becomes the run result);
 *  - mode `async`: the endpoint acknowledges and later reports through the callback API
 *    (PATCH {{ run.callback.url }} with `Authorization: Bearer {{ run.callback.token }}`).
 * With `secret`, requests carry `X-Asterius-Signature: sha256=<HMAC of the body>`.
 */
export const webhookInvoker: Invoker = {
  info: {
    type: 'webhook',
    title: 'Webhook (HTTP)',
    description: 'POST the run to any HTTP endpoint, synchronously or with a callback.',
    fields: [
      { key: 'url', label: 'URL', kind: 'text', required: true, placeholder: 'https://my-service.internal/provision/{{ inputs.name }}' },
      { key: 'method', label: 'Method', kind: 'select', options: ['POST', 'PUT', 'PATCH', 'GET', 'DELETE'] },
      {
        key: 'mode',
        label: 'Completion',
        kind: 'select',
        options: ['sync', 'async'],
        help: 'sync: a 2xx answer completes the run · async: the service reports later through the callback API',
      },
      { key: 'headers', label: 'Headers', kind: 'keyvalue', help: 'e.g. Authorization: Bearer ${secret:TOKEN}' },
      { key: 'body', label: 'Body', kind: 'json', help: 'Empty: the whole run context (inputs, entity, requester, callback)' },
      { key: 'secret', label: 'Signing secret', kind: 'secret', help: 'Adds X-Asterius-Signature: sha256=<HMAC of the body>', advanced: true },
    ],
    example: {
      type: 'webhook',
      url: 'https://my-service.internal/provision',
      method: 'POST',
      mode: 'async',
      headers: { Authorization: 'Bearer ${secret:MY_SERVICE_TOKEN}' },
      body: { name: '{{ inputs.name }}', owner: '{{ trigger.user.email }}', callback: '{{ run.callback }}' },
      secret: '${secret:WEBHOOK_SIGNING_KEY}',
    },
  },
  validate(c) {
    requireFields(c, ['url'], 'webhook');
    if (c.mode && !['sync', 'async'].includes(str(c.mode))) throw new Error('webhook invoker: mode is sync or async');
  },
  async start({ ctx, config, log }) {
    const body = JSON.stringify(config.body ?? { run: ctx.run, action: ctx.action, inputs: ctx.inputs, entity: ctx.entity, trigger: ctx.trigger });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-asterius-run-id': ctx.run.id,
      'idempotency-key': ctx.run.idempotencyKey, // same for every retry of this step
      ...(config.headers as Record<string, string>),
    };
    if (config.secret) headers['x-asterius-signature'] = `sha256=${createHmac('sha256', str(config.secret)).update(body).digest('hex')}`;
    const method = str(config.method || 'POST').toUpperCase();
    await log(`${method} ${new URL(str(config.url)).origin}${new URL(str(config.url)).pathname}`);
    const res = await http(str(config.url), { method, headers, body: method === 'GET' ? undefined : body });
    await log(`Answered ${res.status}`);
    if (config.mode === 'async') return { status: 'IN_PROGRESS', statusLabel: 'Waiting for the service to report' };
    return { status: 'SUCCESS', result: typeof res.data === 'string' ? res.data.slice(0, 4000) || null : res.data };
  },
};
