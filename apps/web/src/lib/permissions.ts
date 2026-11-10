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

export interface RunAccess {
  /** Who may run it, one entry per kind of subject ("Team: Payments", "Role: approver"…); empty: no restriction. */
  who: string[];
  /** What to do to get access. */
  ask: string;
}

const listOf = (one: string, many: string, items: string[]) => `${items.length > 1 ? many : one}: ${items.join(', ')}`;

/**
 * Who may run a form action, for people who cannot (so a disabled action is not a dead end). `teamTitle` resolves
 * team identifiers; `entity` is the target of a day-2 action (its owner team may be allowed).
 */
export function runAccess(a: Pick<Action, 'trigger' | 'enabled'>, teamTitle: (id: string) => string, entity?: { team: string | null } | null): RunAccess {
  const s = formOf(a)?.allowed ?? {};
  const who: string[] = [];
  const teams = (s.teams ?? []).map(teamTitle);
  if (teams.length) who.push(listOf('Team', 'Teams', teams));
  if (s.roles?.length) who.push(listOf('Role', 'Roles', s.roles));
  if (s.users?.length) who.push(listOf('Person', 'People', s.users));
  const owner = s.ownerTeam && entity?.team ? teamTitle(entity.team) : null;
  if (s.ownerTeam) who.push(owner ? `Owner team: ${owner}` : entity ? 'Owner team of the entity' : "The target entity's owner team");
  let ask: string;
  if (!a.enabled) ask = 'This action is disabled.';
  else if (!who.length) ask = 'Ask an admin of the organization why you cannot run it.';
  else if (owner) ask = `Ask a member of ${owner} (owner of this entity) to run it for you or to give you access.`;
  else if (teams.length)
    ask = `Ask a member of ${teams.join(' or ')} to run it for you, or an admin to add you to ${teams.length > 1 ? 'one of these teams' : 'this team'}.`;
  else ask = 'Ask one of them to run it for you, or an admin of the organization for access.';
  return { who, ask };
}
