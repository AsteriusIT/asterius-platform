import { createHmac, randomUUID } from 'node:crypto';
import type { ServiceStatus } from './state.ts';

/**
 * Delivery to the portal inbound webhook `POST <portal>/api/v1/ingest/crossplane-watcher`.
 *
 * Authentication is the generic HMAC scheme of the portal's `verifyWebhook` (apps/server/src/integrations/sync.ts):
 * the integration declares `signatureHeader: x-watcher-signature` and the header carries `sha256=<hex HMAC-SHA256 of
 * the raw body>`. `X-Asterius-Delivery` is a unique id per POST (the portal drops replays of the same id), and the body
 * carries `sentAt`, which the mapping uses to ignore stale deliveries.
 */

export const SIGNATURE_HEADER = 'x-watcher-signature';
export const INTEGRATION = 'crossplane-watcher';
/** The portal rejects payloads with more items than this per delivery (MAX_ITEMS_PER_EVENT is 1000, kept well below). */
export const BATCH_SIZE = 100;

export interface Payload {
  source: 'crossplane-watcher';
  sentAt: string;
  /** `full` for the periodic resync (every service), `delta` for changes. */
  mode: 'full' | 'delta';
  services: ServiceStatus[];
}

export const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export function batches<T>(items: T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface PortalClient {
  send(services: ServiceStatus[], mode: Payload['mode']): Promise<void>;
}

export function portalClient(opts: {
  url: string;
  secret: string;
  org?: string;
  fetch?: typeof fetch;
  onResult?: (ok: boolean, status: number) => void;
  timeoutMs?: number;
}): PortalClient {
  const f = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/$/, '');
  const endpoint = opts.org ? `${base}/api/v1/ingest/${encodeURIComponent(opts.org)}/${INTEGRATION}` : `${base}/api/v1/ingest/${INTEGRATION}`;
  return {
    async send(services, mode) {
      for (const chunk of batches(services)) {
        const body = JSON.stringify({ source: 'crossplane-watcher', sentAt: new Date().toISOString(), mode, services: chunk } satisfies Payload);
        let res: Response;
        try {
          res = await f(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(opts.secret, body), 'x-asterius-delivery': randomUUID() },
            body,
            signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
          });
        } catch (err) {
          opts.onResult?.(false, 0);
          throw err;
        }
        opts.onResult?.(res.ok, res.status);
        if (!res.ok) throw new Error(`portal ingest answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      }
    },
  };
}
