import { all, now, run } from '../db.js';
import { emit } from '../events.js';
import { forEachOrg } from '../orgs/orgs.js';
import { orgId } from '../orgs/context.js';
import { findEntity } from './entities.js';

/**
 * Entity expiry (ephemeral environments): a blueprint with a `ttlProperty` names a date / date-time property. Once its
 * value is in the past the entity is announced with one `entity.expired` event (webhooks, workflow event triggers).
 *
 * Exactly once per expiry value, on any number of replicas: the value that was announced is recorded in
 * `entity_expiry` and the claim is a conditional upsert (it changes a row only when the recorded value differs), so
 * the replica that wins the claim emits and the others see no change. Moving the date re-arms the entity.
 * A date without a time expires at the end of that day (UTC).
 */

const PAGE = 500;
const DAY_MS = 86_400_000;

/** Epoch milliseconds at which the value expires; null when it is not a date. */
export function expiryTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? t + DAY_MS : t;
}

/** Emit `entity.expired` for the entities of the current organization that expired since their last announcement. */
export async function expireEntities(at = Date.now()): Promise<number> {
  const org = orgId();
  let emitted = 0;
  const blueprints = await all<{ identifier: string; ttl_property: string }>(
    'SELECT identifier, ttl_property FROM blueprints WHERE org_id = ? AND ttl_property IS NOT NULL',
    org,
  );
  for (const bp of blueprints) {
    let after = '';
    for (;;) {
      // Cheap pre-filter on the stored JSON; the exact check is done on the parsed value.
      const rows = await all<{ identifier: string; properties: string; emitted: string | null }>(
        `SELECT e.identifier, e.properties, x.expires AS emitted FROM entities e
         LEFT JOIN entity_expiry x ON x.org_id = e.org_id AND x.blueprint = e.blueprint AND x.identifier = e.identifier
         WHERE e.org_id = ? AND e.blueprint = ? AND e.identifier > ? AND e.properties LIKE ?
         ORDER BY e.identifier LIMIT ${PAGE}`,
        org,
        bp.identifier,
        after,
        `%"${bp.ttl_property}"%`,
      );
      for (const r of rows) {
        after = r.identifier;
        let value: unknown;
        try {
          value = (JSON.parse(r.properties) as Record<string, unknown>)[bp.ttl_property];
        } catch {
          continue;
        }
        const t = expiryTime(value);
        if (t === null || t > at || value === r.emitted) continue;
        const claim = await run(
          `INSERT INTO entity_expiry (org_id, blueprint, identifier, expires, emitted_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (org_id, blueprint, identifier) DO UPDATE SET expires = excluded.expires, emitted_at = excluded.emitted_at
           WHERE entity_expiry.expires != excluded.expires`,
          org,
          bp.identifier,
          r.identifier,
          value as string,
          now(),
        ).catch(() => ({ changes: 0 })); // the entity was deleted meanwhile (foreign key)
        if (!claim.changes) continue; // another replica announced this expiry
        const entity = await findEntity(bp.identifier, r.identifier);
        if (!entity) continue;
        await emit({ type: 'entity.expired', blueprint: bp.identifier, data: { entity, property: bp.ttl_property, expiresAt: value } });
        emitted++;
      }
      if (rows.length < PAGE) break;
    }
  }
  return emitted;
}

/** Every organization. */
export const expireAllOrganizations = () => forEachOrg(() => expireEntities(), 'entity expiry');
