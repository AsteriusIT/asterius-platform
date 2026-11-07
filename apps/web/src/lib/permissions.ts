import type { Action, FormTrigger, PublicUser, Subjects } from '@asterius/shared';

/**
 * Client-side copy of the server's `matchesSubjects` (apps/server/src/auth/users.ts), used to show which actions
 * a user can run without one request per entity. The server still checks every run.
 */
export function matchesSubjects(user: Pick<PublicUser, 'role' | 'email' | 'teams'> & { roles?: string[] }, s: Subjects | undefined, ownerTeam: string | null) {
  if (!s || !(s.roles?.length || s.teams?.length || s.users?.length || s.ownerTeam)) return true;
  const teams = user.teams.map((t) => t.identifier);
  if (s.roles?.some((r) => r === user.role || user.roles?.includes(r))) return true;
  if (s.teams?.some((t) => teams.includes(t))) return true;
  if (s.users?.some((u) => u.toLowerCase() === user.email.toLowerCase())) return true;
  return !!(s.ownerTeam && ownerTeam && teams.includes(ownerTeam));
}

/** The form of a workflow started by a user (null: schedule, event, webhook or API trigger). */
export const formOf = (a: Pick<Action, 'trigger'>): FormTrigger | null => (a.trigger?.type === 'form' ? a.trigger : null);

/** A workflow can be started once it has a trigger and at least one step. */
export const isRunnable = (a: Action) => !!a.trigger && a.steps.length > 0;

export const canRunOn = (a: Action, user: (Pick<PublicUser, 'role' | 'email' | 'teams'> & { roles?: string[] }) | null, ownerTeam: string | null) =>
  !!user && a.enabled && isRunnable(a) && !!formOf(a) && matchesSubjects(user, formOf(a)?.allowed, ownerTeam);
