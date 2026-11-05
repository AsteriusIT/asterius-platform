import type { Action, PublicUser, Subjects } from '@asterius/shared';

/**
 * Client-side copy of the server's `matchesSubjects` (apps/server/src/auth/users.ts), used to show which actions
 * a user can run without one request per entity. The server still checks every run.
 */
export function matchesSubjects(user: Pick<PublicUser, 'role' | 'email' | 'teams'>, s: Subjects | undefined, ownerTeam: string | null) {
  if (!s || !(s.roles?.length || s.teams?.length || s.users?.length || s.ownerTeam)) return true;
  const teams = user.teams.map((t) => t.identifier);
  if (s.roles?.includes(user.role)) return true;
  if (s.teams?.some((t) => teams.includes(t))) return true;
  if (s.users?.some((u) => u.toLowerCase() === user.email.toLowerCase())) return true;
  return !!(s.ownerTeam && ownerTeam && teams.includes(ownerTeam));
}

/** A workflow can be started once it has a trigger and at least one step. */
export const isRunnable = (a: Action) => !!a.trigger && a.steps.length > 0;

export const canRunOn = (a: Action, user: Pick<PublicUser, 'role' | 'email' | 'teams'> | null, ownerTeam: string | null) =>
  !!user && a.enabled && isRunnable(a) && matchesSubjects(user, a.trigger?.allowed, ownerTeam);
