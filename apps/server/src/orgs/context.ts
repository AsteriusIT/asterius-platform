import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The organization (tenant) a piece of work belongs to. Every org-scoped query reads it from here, so the data
 * functions keep their signatures. Set once per HTTP request (after authentication) and per background job (run
 * step, sync, delivery, config apply). Missing context throws: a query can never silently run across tenants.
 */

interface OrgStore {
  orgId: string | null;
}

const als = new AsyncLocalStorage<OrgStore>();

/** The current organization id; throws outside an organization context. */
export function orgId(): string {
  const id = als.getStore()?.orgId;
  if (!id) throw new Error('No organization in context');
  return id;
}

/** The current organization id, or null (platform-level code paths). */
export const maybeOrgId = () => als.getStore()?.orgId ?? null;

/** Run `fn` inside an organization (background jobs, config loader, tests). */
export function withOrg<T>(id: string, fn: () => T): T {
  return als.run({ orgId: id }, fn);
}

/** HTTP: open an empty context for the request (onRequest); authentication fills it in. */
export function openRequestContext(done: () => void) {
  als.run({ orgId: null }, done);
}

/** Set the organization of the current request context (after authentication). */
export function enterOrg(id: string) {
  const store = als.getStore();
  if (!store) throw new Error('No request context');
  store.orgId = id;
}

/** Organization of the seed data and of installs from before multi-tenancy. */
export const DEFAULT_ORG = 'default';
