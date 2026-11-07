import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';

const port = vi.hoisted(() => {
  const p = 20000 + Math.floor(Math.random() * 20000);
  process.env.AUDIT_HASH_CHAIN = 'true';
  process.env.AUDIT_CHAIN_KEY = 'test-chain-key';
  process.env.AUDIT_STREAM_URL = `http://127.0.0.1:${p}/events`;
  process.env.AUDIT_STREAM_TOKEN = 'siem-token';
  process.env.AUDIT_STREAM_SECRET = 'siem-secret';
  return p;
});

let app: FastifyInstance;
let admin: Api;
let adminToken: string;
let siem: http.Server;
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  siem = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => siem.listen(port, '127.0.0.1', r));
  app = await testApp();
  adminToken = (await register(app, 'admin@example.com')).token;
  admin = client(app, adminToken);
});
afterAll(async () => {
  await app.close();
  siem.close();
});

describe('audit log', () => {
  it('records failed logins and admin operations that used to be silent', async () => {
    await client(app).post('/api/auth/login', { email: 'ghost@example.com', password: 'wrong-password-1' });
    await admin.get('/api/v1/config/export');
    const log = (await admin.get('/api/v1/audit?action=auth.*&limit=50')).data as { action: string; actorEmail: string; detail: { reason?: string } }[];
    const failed = log.find((e) => e.action === 'auth.login_failed');
    expect(failed).toMatchObject({ actorEmail: 'ghost@example.com', detail: { reason: 'unknown account' } });
    expect(JSON.stringify((await admin.get('/api/v1/audit')).data)).not.toContain('wrong-password-1');
    expect(((await admin.get('/api/v1/audit?action=config.exported')).data as unknown[]).length).toBe(1);
  });

  it('filters by actor, action, target and date, and offers facets', async () => {
    await admin.put('/api/v1/teams/payments', { title: 'Payments' });
    const byTarget = (await admin.get('/api/v1/audit?target=payments')).data as { action: string }[];
    expect(byTarget.map((e) => e.action)).toContain('team.created');
    const byActor = (await admin.get('/api/v1/audit?actor=admin@')).data as { actorEmail: string }[];
    expect(byActor.length).toBeGreaterThan(0);
    expect(byActor.every((e) => e.actorEmail.startsWith('admin@'))).toBe(true);
    expect(((await admin.get('/api/v1/audit?from=2999-01-01T00:00:00Z')).data as unknown[]).length).toBe(0);
    expect((await admin.get('/api/v1/audit?from=yesterday')).status).toBe(400);
    const facets = (await admin.get('/api/v1/audit/facets')).data as { actions: { value: string }[]; actors: { value: string }[] };
    expect(facets.actions.map((a) => a.value)).toContain('team.created');
    expect(facets.actors.map((a) => a.value)).toContain('admin@example.com');
  });

  it('exports CSV neutralizing formulas, and NDJSON; exporting is audited', async () => {
    await admin.put('/api/v1/teams/evil', { title: '=HYPERLINK("http://evil")' });
    const csv = (await admin.get('/api/v1/audit/export?format=csv&action=team.*')).data as string;
    expect(csv.split('\n')[0]).toBe('id,at,action,actor,target,detail');
    expect(csv).toContain('team.created');
    const nd = (await app.inject({ method: 'GET', url: '/api/v1/audit/export?format=json', headers: { authorization: `Bearer ${adminToken}` } })).body;
    const lines = nd
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { action: string });
    expect(lines.length).toBeGreaterThan(3);
    expect(((await admin.get('/api/v1/audit?action=audit.exported')).data as unknown[]).length).toBe(2);
    const { csvCell } = await import('../src/audit.js');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });

  it('keeps a verifiable hash chain and detects tampering', async () => {
    const ok = (await admin.get('/api/v1/audit/verify')).data;
    expect(ok).toMatchObject({ enabled: true, ok: true });
    expect(ok.checked).toBeGreaterThan(5);

    const { run, one } = await import('../src/db.js');
    const victim = await one<{ id: string; chain_seq: number }>("SELECT id, chain_seq FROM audit_log WHERE action = 'team.created' ORDER BY chain_seq LIMIT 1");
    await run("UPDATE audit_log SET actor_email = 'someone-else@example.com' WHERE id = ?", victim!.id);
    const broken = (await admin.get('/api/v1/audit/verify')).data;
    expect(broken).toMatchObject({ ok: false, brokenAt: Number(victim!.chain_seq), reason: 'entry was modified' });
    await run("UPDATE audit_log SET actor_email = 'admin@example.com' WHERE id = ?", victim!.id);
    expect((await admin.get('/api/v1/audit/verify')).data.ok).toBe(true);

    await run('DELETE FROM audit_log WHERE id = ?', victim!.id);
    expect((await admin.get('/api/v1/audit/verify')).data).toMatchObject({ ok: false, reason: 'missing entry' });
  });

  it('streams entries to the SIEM once, signed, and resumes where it left off', async () => {
    const { flushAuditStream, syslogLine } = await import('../src/audit-stream.js');
    const first = await flushAuditStream();
    expect(first).toBeGreaterThan(0);
    const req = received[0]!;
    expect(req.headers.authorization).toBe('Bearer siem-token');
    expect(req.headers['x-asterius-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    const events = (JSON.parse(req.body) as { events: { action: string; source: string }[] }).events;
    expect(events[0]!.source).toBe('asterius-platform');
    expect(await flushAuditStream()).toBe(0); // nothing new
    await admin.put('/api/v1/teams/later', { title: 'Later' });
    expect(await flushAuditStream()).toBe(1);
    expect(syslogLine({ id: 'x', at: '2026-01-01T00:00:00.000Z', action: 'a b', actor_email: 'u@x', target: null, detail: '{}', org_id: null })).toMatch(
      /^<110>1 2026-01-01T00:00:00.000Z \S+ asterius-platform - a_b - \{/,
    );
  });
});
