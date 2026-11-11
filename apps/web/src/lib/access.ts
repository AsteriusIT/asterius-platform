import type { PublicUser } from '@asterius/shared';

/**
 * Parts of the administration a user may reach. `admin` is everything only organization admins may use; the others
 * mirror the server's `requireRole(...)` guards (routes/integrations.ts, routes/catalog.ts).
 */
export type AdminArea = 'admin' | 'blueprints' | 'integrations';

/** What each delegated role grants on top of `member` (keep in sync with DELEGATED_ROLES in apps/server/src/schemas.ts). */
export const DELEGATED_ROLES: Record<string, { label: string; description: string; areas: readonly AdminArea[] }> = {
  'integration-admin': {
    label: 'Integration admin',
    description: 'Manages integrations (ingestion sources, their mappings and syncs) and connections to external tools.',
    areas: ['integrations'],
  },
  'blueprint-owner': {
    label: 'Blueprint owner',
    description: 'Creates, edits, migrates and deletes blueprints (the catalog model).',
    areas: ['blueprints'],
  },
  approver: {
    label: 'Approver',
    description: 'Decides the approvals of workflows that name no approvers of their own.',
    areas: [],
  },
};

/** Readable name of a delegated role; custom role slugs are shown as they are. */
export const roleLabel = (role: string) => DELEGATED_ROLES[role]?.label ?? role;
export const roleDescription = (role: string) =>
  DELEGATED_ROLES[role]?.description ?? 'Custom role: grants what blueprint and workflow permissions give to it.';

/** May `user` administer `area` in the organization the request ran in? Admins administer everything. */
export function canAdminister(user: Pick<PublicUser, 'role' | 'roles' | 'organization'> | null | undefined, area: AdminArea): boolean {
  if (!user?.organization) return false;
  if (user.role === 'admin') return true;
  if (area === 'admin') return false;
  return (user.roles ?? []).some((r) => DELEGATED_ROLES[r]?.areas.includes(area));
}
