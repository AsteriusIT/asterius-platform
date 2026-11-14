import type { Agent } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../db.js';
import { badRequest, conflict, forbidden, HttpError, managedError, notFound } from '../lib/errors.js';
import { agentDef, type AgentDef } from '../schemas.js';
import { orgId } from '../orgs/context.js';
import type { AgentGrant, Principal } from '../auth/users.js';

/**
 * The agent registry: AI agents as first-class principals of an organization (admin API or CONFIG_DIR `agents:`).
 *
 * An agent never has rights of its own. It acts through a user (the user of an API token bound to it, or the person
 * signed in to an OAuth MCP client identified as it) and its allow-lists narrow that user's rights:
 *  - `workflows`: the only actions it may see, start and whose runs it may read;
 *  - `blueprints`: the only blueprints whose entities it may read (`*`: all the user may read);
 *  - it never approves, rejects or answers input steps, never uses administrator bypasses and, on the REST API, only reads
 *    the catalog and runs and starts runs (auth/users.ts).
 * A disabled or deleted agent stops working at once: its tokens are refused.
 */

interface Row {
  identifier: string;
  title: string;
  description: string;
  owner_team: string;
  workflows: string;
  blueprints: string;
  oauth_clients: string;
  enabled: number;
  version: number;
  managed: number;
  created_at: string;
  updated_at: string;
}

const defOf = (r: Row): AgentDef => ({
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  ownerTeam: r.owner_team,
  workflows: json(r.workflows, []),
  blueprints: json(r.blueprints, []),
  oauthClients: json(r.oauth_clients, []),
  enabled: bool(r.enabled),
});

const toAgent = (r: Row, tokens?: number): Agent => ({
  ...defOf(r),
  version: Number(r.version),
  managed: bool(r.managed),
  ...(tokens !== undefined ? { tokens } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listAgents(): Promise<Agent[]> {
  const org = orgId();
  const counts = new Map(
    (
      await all<{ agent: string; n: number }>(
        'SELECT agent, count(*) AS n FROM api_tokens WHERE org_id = ? AND agent IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) GROUP BY agent',
        org,
        now(),
      )
    ).map((r) => [r.agent, Number(r.n)]),
  );
  return (await all<Row>('SELECT * FROM agents WHERE org_id = ? ORDER BY title', org)).map((r) => toAgent(r, counts.get(r.identifier) ?? 0));
}

const findRow = (id: string) => one<Row>('SELECT * FROM agents WHERE org_id = ? AND identifier = ?', orgId(), id);

export async function getAgent(id: string): Promise<Agent> {
  const r = await findRow(id);
  if (!r) throw notFound(`Agent ${id}`);
  return toAgent(r);
}

export async function upsertAgent(
  input: unknown,
  opts: { managed?: boolean; ifMatch?: number } = {},
): Promise<{ agent: Agent; created: boolean; changed: boolean }> {
  const parsed = agentDef.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.') || 'agent'}: ${i.message}`).join('; '));
  const a = parsed.data;
  const org = orgId();
  if (!(await one('SELECT identifier FROM teams WHERE org_id = ? AND identifier = ?', org, a.ownerTeam)))
    throw badRequest(`ownerTeam: unknown team "${a.ownerTeam}"`);
  if (a.blueprints.includes('*') && a.blueprints.length > 1) throw badRequest('blueprints: use either "*" or a list of blueprints');
  // An OAuth client identifies one agent only.
  for (const c of a.oauthClients) {
    const other = (
      await all<Row>(
        "SELECT * FROM agents WHERE org_id = ? AND identifier != ? AND oauth_clients LIKE ? ESCAPE '\\'",
        org,
        a.identifier,
        `%${c.replace(/[\\%_]/g, (m) => `\\${m}`)}%`,
      )
    ).find((r) => json<string[]>(r.oauth_clients, []).includes(c));
    if (other) throw badRequest(`oauthClients: "${c}" already identifies agent ${other.identifier}`);
  }
  const existing = await findRow(a.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Agent', a.identifier);
  if (opts.ifMatch !== undefined && (existing ? Number(existing.version) : undefined) !== opts.ifMatch)
    throw new HttpError(412, `Agent ${a.identifier} is at version ${existing ? existing.version : 'none'}, not ${opts.ifMatch}; reload and retry`, {
      conflict: { currentVersion: existing ? Number(existing.version) : null, changedBy: null, changedAt: existing?.updated_at ?? null },
    });
  const vals = [
    a.title,
    a.description,
    a.ownerTeam,
    JSON.stringify(a.workflows),
    JSON.stringify(a.blueprints),
    JSON.stringify(a.oauthClients),
    a.enabled ? 1 : 0,
    opts.managed ? 1 : 0,
  ];
  const changed = !existing || JSON.stringify(defOf(existing)) !== JSON.stringify(a);
  const t = now();
  if (existing) {
    const { changes } = await run(
      'UPDATE agents SET title = ?, description = ?, owner_team = ?, workflows = ?, blueprints = ?, oauth_clients = ?, enabled = ?, managed = ?, version = ?, updated_at = ? WHERE org_id = ? AND identifier = ? AND version = ?',
      ...vals,
      Number(existing.version) + (changed ? 1 : 0),
      changed ? t : existing.updated_at,
      org,
      a.identifier,
      Number(existing.version),
    );
    if (!changes) throw conflict('The agent was changed by someone else meanwhile; reload and try again');
  } else
    await run(
      'INSERT INTO agents (title, description, owner_team, workflows, blueprints, oauth_clients, enabled, managed, version, created_at, updated_at, org_id, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
      ...vals,
      t,
      t,
      org,
      a.identifier,
    );
  return { agent: await getAgent(a.identifier), created: !existing, changed };
}

/** Deleting an agent revokes its tokens. */
export async function deleteAgent(id: string, opts: { managed?: boolean } = {}) {
  const r = await findRow(id);
  if (!r) throw notFound(`Agent ${id}`);
  if (bool(r.managed) && !opts.managed) throw managedError('Agent', id);
  await run('DELETE FROM api_tokens WHERE org_id = ? AND agent = ?', orgId(), id);
  await run('DELETE FROM agents WHERE org_id = ? AND identifier = ?', orgId(), id);
}

// ---------- acting as an agent ----------
export const grantOf = (a: Pick<AgentDef, 'identifier' | 'title' | 'workflows' | 'blueprints'>): AgentGrant => ({
  identifier: a.identifier,
  title: a.title,
  workflows: [...a.workflows],
  blueprints: [...a.blueprints],
});

/** May this person act as the agent (issue its tokens, select it on an MCP client)? Admins and members of its owner team. */
export const mayActAs = (p: Principal, a: Pick<AgentDef, 'ownerTeam'>) => p.role === 'admin' || p.teams.includes(a.ownerTeam);

/**
 * The grant of an agent in the current organization for a caller about to act as it (403 when it is unknown, disabled
 * or the caller may not use it).
 */
export async function agentGrant(id: string, p: Principal, opts: { checkOwner?: boolean } = {}): Promise<AgentGrant> {
  const r = await findRow(id);
  if (!r) throw forbidden(`Unknown agent "${id}"`);
  const a = defOf(r);
  if (!a.enabled) throw forbidden(`Agent "${id}" is disabled`);
  if (opts.checkOwner !== false && !mayActAs(p, a)) throw forbidden(`You cannot act as agent "${id}" (admins and members of team ${a.ownerTeam} only)`);
  return grantOf(a);
}

/** The agent an OAuth client id identifies in the current organization, if any. */
export async function agentOfOauthClient(clientId: string): Promise<AgentDef | undefined> {
  const rows = await all<Row>(
    "SELECT * FROM agents WHERE org_id = ? AND oauth_clients LIKE ? ESCAPE '\\'",
    orgId(),
    `%${clientId.replace(/[\\%_]/g, (m) => `\\${m}`)}%`,
  );
  const r = rows.find((x) => json<string[]>(x.oauth_clients, []).includes(clientId));
  return r ? defOf(r) : undefined;
}

/** Act as an agent: the principal keeps its user, roles and teams; the grant narrows what it may do. */
export function asAgent(p: Principal, grant: AgentGrant): Principal {
  return { ...p, agent: grant };
}

/** Approvals and human input stay with people. */
export function assertHuman(p: Principal, what = 'decide on approvals') {
  if (p.agent) throw forbidden(`AI agents cannot ${what}: decisions stay with people`);
}

/** May the agent principal see and start this workflow (always true for non-agents)? */
export const agentMayRun = (p: Pick<Principal, 'agent'>, action: string) => !p.agent || p.agent.workflows.includes(action);
