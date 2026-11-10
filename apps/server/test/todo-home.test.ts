import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HomeSummary, Run } from '@asterius/shared';
import { client, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';

/** The "To do" inbox and the personal home strip: requests waiting on others, the "My teams" run scope, team entities. */

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let bob: Api;
let carol: Api;
let stop: () => unknown;

const form = { type: 'form', on: 'create', inputs: { properties: {} } };
const save = async (id: string, body: object) => {
  const res = await admin.put(`/api/v1/actions/${id}`, { title: id, trigger: form, ...body });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
};
const start = async (api: Api, id: string, entity?: string) => {
  const res = await api.post(`/api/v1/actions/${id}/runs`, { inputs: {}, ...(entity ? { entity } : {}) });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.id as string;
};
const waiting = async (api: Api) => (await api.get('/api/v1/runs/waiting')).data as Run[];
const stepStatus = (id: string, step: string, status: string) =>
  waitFor(async () => {
    const r = (await admin.get(`/api/v1/runs/${id}`)).data as Run;
    return r.steps?.find((s) => s.id === step)?.status === status && r;
  }, 20_000);

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com', 'Admin')).token);
  alice = client(app, (await register(app, 'alice@example.com', 'Alice')).token);
  bob = client(app, (await register(app, 'bob@example.com', 'Bob')).token);
  carol = client(app, (await register(app, 'carol@example.com', 'Carol')).token);
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });
  await admin.put('/api/v1/teams/search', { title: 'Search' });
  const users = (await admin.get('/api/v1/users')).data as { id: string; email: string }[];
  const id = (email: string) => users.find((u) => u.email === email)!.id;
  await admin.patch(`/api/v1/users/${id('alice@example.com')}`, { teams: ['payments'] });
  await admin.patch(`/api/v1/users/${id('bob@example.com')}`, { teams: ['payments'] });
  await admin.patch(`/api/v1/users/${id('carol@example.com')}`, { teams: ['search'] });
  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: {} } });
  await admin.put('/api/v1/blueprints/service/entities/pay-api', { title: 'Pay API', team: 'payments' });
  await admin.put('/api/v1/blueprints/service/entities/search-api', { title: 'Search API', team: 'search' });
  await admin.put('/api/v1/blueprints/service/entities/orphan', { title: 'Orphan' });
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await app.close();
});

describe('requests waiting on others', () => {
  it('lists a pre-start approval with its approvers, and drops it once decided', async () => {
    await save('pre', {
      trigger: { ...form, approval: { required: true, approvers: { users: ['carol@example.com'], roles: ['approver'] } } },
      steps: [{ id: 't', type: 'transform', output: { x: '1' } }],
    });
    const id = await start(alice, 'pre');
    const mine = (await waiting(alice)).find((r) => r.id === id);
    expect(mine).toMatchObject({ status: 'PENDING_APPROVAL', pendingStep: null, waitingOn: { users: ['carol@example.com'], roles: ['approver'], teams: [] } });
    expect((await waiting(bob)).some((r) => r.id === id)).toBe(false); // only the requester's own runs
    expect((await carol.post(`/api/v1/runs/${id}/approve`, { comment: '' })).status).toBe(200);
    expect((await waiting(alice)).some((r) => r.id === id)).toBe(false);
  });

  it('lists an approval step (ownerTeam resolved to the run team) and an input step addressed to someone else', async () => {
    await save('steps', {
      trigger: { type: 'form', on: 'day-2', blueprint: 'service', inputs: { properties: {} } },
      steps: [
        { id: 'ok', type: 'approval', approvers: { ownerTeam: true } },
        { id: 'ask', type: 'input', message: 'Which cluster?', assignees: { teams: ['search'] }, inputs: { properties: { c: { type: 'string' } } } },
      ],
    });
    const id = await start(alice, 'steps', 'pay-api');
    await stepStatus(id, 'ok', 'WAITING_APPROVAL');
    expect((await waiting(alice)).find((r) => r.id === id)).toMatchObject({
      pendingStep: { id: 'ok', kind: 'approval' },
      waitingOn: { teams: ['payments'] },
    });
    expect((await bob.post(`/api/v1/runs/${id}/steps/ok/approve`, { comment: '' })).status).toBe(200);
    await stepStatus(id, 'ask', 'WAITING');
    expect((await waiting(alice)).find((r) => r.id === id)).toMatchObject({ pendingStep: { id: 'ask', kind: 'input' }, waitingOn: { teams: ['search'] } });
    const home = (await alice.get('/api/v1/home')).data as HomeSummary;
    expect(home.waitingOnOthers.some((r) => r.id === id)).toBe(true);
    await admin.post(`/api/v1/runs/${id}/cancel`);
  });

  it('leaves out an input step the requester answers themselves (it is in their decisions)', async () => {
    await save('self-input', {
      steps: [{ id: 'ask', type: 'input', message: 'Size?', inputs: { properties: { s: { type: 'string' } } } }],
    });
    const id = await start(alice, 'self-input');
    await stepStatus(id, 'ask', 'WAITING');
    expect((await waiting(alice)).some((r) => r.id === id)).toBe(false);
    expect(((await alice.get('/api/v1/approvals')).data as Run[]).some((r) => r.id === id)).toBe(true);
    await admin.post(`/api/v1/runs/${id}/cancel`);
  });
});

describe('runs of my teams', () => {
  it('restricts to runs whose team is one of the caller teams', async () => {
    await save('poke', {
      trigger: { type: 'form', on: 'day-2', blueprint: 'service', inputs: { properties: {} } },
      steps: [{ id: 't', type: 'transform', output: { x: '1' } }],
    });
    const pay = await start(bob, 'poke', 'pay-api');
    const other = await start(carol, 'poke', 'search-api');
    const orphan = await start(alice, 'poke', 'orphan');
    const ids = async (api: Api, q: string) => ((await api.get(`/api/v1/runs?${q}`)).data.items as Run[]).map((r) => r.id);
    const team = await ids(alice, 'myTeams=true&action=poke');
    expect(team).toContain(pay);
    expect(team).not.toContain(other);
    expect(team).not.toContain(orphan); // her own, but not of a team
    expect(await ids(carol, 'myTeams=true&action=poke')).toEqual([other]);
    // Admin without teams: nothing, though admins see every run otherwise.
    expect(await ids(admin, 'myTeams=true&action=poke')).toEqual([]);
    expect((await ids(admin, 'action=poke')).length).toBe(3);
  });
});

describe('home', () => {
  it('returns recently changed entities of the caller teams', async () => {
    const home = (await alice.get('/api/v1/home')).data as HomeSummary;
    expect(home.teamEntities.map((e) => e.identifier)).toEqual(['pay-api']);
    expect(typeof home.pendingApprovals).toBe('number');
    expect(Array.isArray(home.myRuns)).toBe(true);
    expect(((await admin.get('/api/v1/home')).data as HomeSummary).teamEntities).toEqual([]);
  });
});
