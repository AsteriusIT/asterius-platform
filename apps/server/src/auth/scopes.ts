import { BlockList, isIP } from 'node:net';
import { z } from 'zod';

/**
 * API token scopes. A token without scopes (created before scopes existed) keeps the full rights of its user.
 * Scopes can only narrow what the user may do, never widen it.
 *   catalog:read   read blueprints and entities
 *   catalog:write  write entities (implies catalog:read)
 *   runs:read      read actions, runs and approvals
 *   runs:trigger   start, approve, reject and cancel runs (implies runs:read)
 *   admin          everything, including administration endpoints and token management
 *   scim           SCIM provisioning under /scim/v2 only (issued by POST /api/v1/scim/token, grants nothing else)
 */
export const SCOPES = ['catalog:read', 'catalog:write', 'runs:read', 'runs:trigger', 'admin', 'scim'] as const;
export type Scope = (typeof SCOPES)[number];
export const scopeSchema = z.enum(SCOPES);

const IMPLIES: Record<Scope, Scope[]> = {
  admin: ['admin', 'catalog:read', 'catalog:write', 'runs:read', 'runs:trigger'],
  'catalog:write': ['catalog:write', 'catalog:read'],
  'catalog:read': ['catalog:read'],
  'runs:trigger': ['runs:trigger', 'runs:read'],
  'runs:read': ['runs:read'],
  scim: ['scim'],
};

export const grants = (held: readonly string[], needed: Scope) => held.some((s) => IMPLIES[s as Scope]?.includes(needed));

/** Scope a request needs, from its method and path (anything not recognised needs `admin`). */
export function requiredScope(method: string, url: string): Scope {
  if (url.startsWith('/scim/v2/')) return 'scim';
  const path = url.split('?')[0]!.replace(/^\/api\/(v1\/)?/, '');
  const [first, , third] = path.split('/');
  const read = method === 'GET' || method === 'HEAD';
  if (path === 'auth/me' || path === 'permissions') return 'catalog:read';
  if (first === 'home' || first === 'entities') return 'catalog:read';
  if (first === 'blueprints') {
    // PUT/DELETE /blueprints/:bp changes the model; entity routes are catalog data (running actions is /actions/:id/runs).
    if (third === undefined) return read ? 'catalog:read' : 'admin';
    if (read) return path.endsWith('/actions') ? 'runs:read' : 'catalog:read';
    return 'catalog:write';
  }
  if (first === 'runs' || first === 'approvals') return read ? 'runs:read' : 'runs:trigger';
  if (first === 'actions') {
    if (read) return 'runs:read';
    return path.endsWith('/runs') ? 'runs:trigger' : 'admin';
  }
  if (read && (first === 'teams' || path === 'users/lookup')) return 'catalog:read';
  // Saved catalog views and the caller's own UI preferences (favourites, columns): catalog-level personal data.
  if (first === 'views' || path === 'me/preferences') return read ? 'catalog:read' : 'catalog:write';
  return 'admin';
}

/** Blueprint a request targets, when the path names one. */
export const blueprintOfPath = (url: string) => /^\/api\/v1\/blueprints\/([^/?]+)/.exec(url)?.[1];

// ---------- IP allow-list ----------
const CIDR = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;
export const ipAllowSchema = z
  .array(
    z.string().refine((v) => {
      if (!CIDR.test(v)) return false;
      const [ip, bits] = v.split('/') as [string, string?];
      const fam = isIP(ip);
      return fam !== 0 && (bits === undefined || Number(bits) <= (fam === 4 ? 32 : 128));
    }, 'IP address or CIDR range'),
  )
  .max(50);

export function ipAllowed(ip: string, allow: readonly string[]): boolean {
  if (!allow.length) return true;
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const fam = isIP(addr);
  if (!fam) return false;
  const list = new BlockList();
  for (const entry of allow) {
    const [base, bits] = entry.split('/') as [string, string?];
    const baseFam = isIP(base) === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(base, baseFam);
    else list.addSubnet(base, Number(bits), baseFam);
  }
  return list.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
}
