import { bumpConfigVersion } from '../lib/config-version.js';
import type { Team } from '@asterius/shared';
import { all, bool, now, one, run } from '../db.js';
import { conflict, managedError, notFound } from '../lib/errors.js';
import { teamDef, type TeamDef } from '../schemas.js';

interface Row {
  identifier: string;
  title: string;
  description: string;
  entra_group_id: string | null;
  managed: number;
}

export async function listTeams(): Promise<Team[]> {
  const rows = await all<Row>('SELECT * FROM teams ORDER BY title');
  const members = await all<{ team: string; id: string; name: string; email: string }>(
    'SELECT m.team, u.id, u.name, u.email FROM team_members m JOIN users u ON u.id = m.user_id ORDER BY u.name',
  );
  return rows.map((r) => ({
    identifier: r.identifier,
    title: r.title,
    description: r.description,
    entraGroupId: r.entra_group_id,
    managed: bool(r.managed),
    members: members.filter((m) => m.team === r.identifier).map(({ id, name, email }) => ({ id, name, email })),
  }));
}

export async function upsertTeam(input: unknown, opts: { managed?: boolean } = {}) {
  const def: TeamDef = teamDef.parse(input);
  const existing = await one<Row>('SELECT * FROM teams WHERE identifier = ?', def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Team', def.identifier);
  const vals = [def.title, def.description, def.entraGroupId ?? null, opts.managed ? 1 : 0];
  if (existing) await run('UPDATE teams SET title = ?, description = ?, entra_group_id = ?, managed = ? WHERE identifier = ?', ...vals, def.identifier);
  else
    await run(
      'INSERT INTO teams (title, description, entra_group_id, managed, created_at, identifier) VALUES (?, ?, ?, ?, ?, ?)',
      ...vals,
      now(),
      def.identifier,
    );
  await bumpConfigVersion();
  return { created: !existing };
}

export async function deleteTeam(id: string, opts: { managed?: boolean } = {}) {
  const r = await one<Row>('SELECT * FROM teams WHERE identifier = ?', id);
  if (!r) throw notFound(`Team ${id}`);
  if (bool(r.managed) && !opts.managed) throw managedError('Team', id);
  const owned = await one<{ n: number }>('SELECT count(*) AS n FROM entities WHERE team = ?', id);
  if (Number(owned?.n) > 0) throw conflict(`Team "${id}" owns ${owned!.n} entities; reassign them first`);
  await run('DELETE FROM teams WHERE identifier = ?', id);
  await bumpConfigVersion();
}
