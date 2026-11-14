import type { PriceCatalog } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../db.js';
import { badRequest, conflict, managedError, notFound } from '../lib/errors.js';
import { orgId } from '../orgs/context.js';
import { priceCatalogDef, type PriceCatalogDef } from '../schemas.js';
import { BUILTIN_CATALOG, BUILTIN_CATALOG_ID } from './builtin-prices.js';

/**
 * Price catalogs of the organization (`priceCatalogs:` in configuration files, Admin → Price catalogs). The built-in
 * sample table is not stored: it is always listed, read-only, and an organization catalog may extend it.
 */

interface Row {
  identifier: string;
  title: string;
  definition: string;
  managed: number;
}

const toCatalog = (r: Row): PriceCatalog => ({ ...json<PriceCatalogDef>(r.definition, BUILTIN_CATALOG), identifier: r.identifier, managed: bool(r.managed) });
const builtin = (): PriceCatalog => ({ ...BUILTIN_CATALOG, managed: false, builtin: true });

export async function listPriceCatalogs(opts: { builtin?: boolean } = {}): Promise<PriceCatalog[]> {
  const rows = (await all<Row>('SELECT * FROM price_catalogs WHERE org_id = ? ORDER BY title', orgId())).map(toCatalog);
  return opts.builtin === false ? rows : [builtin(), ...rows];
}

export async function getPriceCatalog(id: string): Promise<PriceCatalog> {
  if (id === BUILTIN_CATALOG_ID) return builtin();
  const r = await one<Row>('SELECT * FROM price_catalogs WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!r) throw notFound(`Price catalog ${id}`);
  return toCatalog(r);
}

export async function upsertPriceCatalog(input: unknown, opts: { managed?: boolean } = {}) {
  const def = priceCatalogDef.parse(input);
  if (def.identifier === BUILTIN_CATALOG_ID)
    throw badRequest(`"${BUILTIN_CATALOG_ID}" is the built-in catalog: choose another identifier (and extends: ${BUILTIN_CATALOG_ID})`);
  if (def.extends === def.identifier) throw badRequest('A price catalog cannot extend itself');
  const org = orgId();
  const existing = await one<Row>('SELECT * FROM price_catalogs WHERE org_id = ? AND identifier = ?', org, def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Price catalog', def.identifier);
  const t = now();
  if (existing)
    await run(
      'UPDATE price_catalogs SET title = ?, definition = ?, managed = ?, updated_at = ? WHERE org_id = ? AND identifier = ?',
      def.title,
      JSON.stringify(def),
      opts.managed ? 1 : 0,
      t,
      org,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO price_catalogs (org_id, identifier, title, definition, managed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      org,
      def.identifier,
      def.title,
      JSON.stringify(def),
      opts.managed ? 1 : 0,
      t,
      t,
    );
  return { catalog: await getPriceCatalog(def.identifier), created: !existing };
}

export async function deletePriceCatalog(id: string, opts: { managed?: boolean } = {}) {
  const c = await getPriceCatalog(id);
  if (c.builtin) throw badRequest('The built-in catalog cannot be deleted');
  if (c.managed && !opts.managed) throw managedError('Price catalog', id);
  const users = (await listPriceCatalogs({ builtin: false })).filter((x) => x.extends === id).map((x) => x.identifier);
  if (users.length) throw conflict(`Price catalog ${id} is extended by ${users.join(', ')}`);
  await run('DELETE FROM price_catalogs WHERE org_id = ? AND identifier = ?', orgId(), id);
}

/**
 * The catalogs a plan check uses, most specific first: `id`, then what it extends (transitively, at most 5 levels).
 * Without an id: the organization's catalog `default` when it exists, else the built-in sample.
 */
export async function catalogChain(id?: string | null): Promise<PriceCatalogDef[]> {
  let first = id || null;
  if (!first) first = (await one('SELECT 1 AS x FROM price_catalogs WHERE org_id = ? AND identifier = ?', orgId(), 'default')) ? 'default' : BUILTIN_CATALOG_ID;
  const chain: PriceCatalogDef[] = [];
  for (let next: string | undefined = first; next;) {
    if (chain.length >= 5 || chain.some((c) => c.identifier === next)) throw new Error(`Price catalog ${first}: extends chain is too long or loops`);
    const c: PriceCatalog = await getPriceCatalog(next);
    if (chain.length && c.currency !== chain[0]!.currency)
      throw new Error(
        `Price catalog ${chain[chain.length - 1]!.identifier} (${chain[0]!.currency}) extends ${c.identifier} (${c.currency}): currencies differ`,
      );
    chain.push(priceCatalogDef.parse(c));
    next = c.extends;
  }
  return chain;
}
