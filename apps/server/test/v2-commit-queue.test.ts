import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { later, run } from '../src/db.js';
import { commitSerialized, isStalePush, parseRepoUrl } from '../src/v2/ado-git.js';
import { commitOperation, type ServiceOpConfig } from '../src/v2/service-ops.js';
import { toYaml, renderServiceSpec } from '../src/v2/spec.js';
import { UpstreamError } from '../src/lib/http.js';
import { fakeAdoGit } from './v2-fake-ado.js';

let ado: Awaited<ReturnType<typeof fakeAdoGit>>;
const RUN = 'aaaaaaaa-1111-4222-8333-444444444444';
const TEMPLATE = 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: team-<team>\n  labels:\n    portal.asterius.io/team: <team>\n';

const cfg = (over: Partial<ServiceOpConfig> = {}): ServiceOpConfig => ({
  repository: ado.url,
  branch: 'main',
  token: 'pat-123',
  operation: 'create',
  team: 'payments',
  service: 'payments-api',
  inputs: { goldenPath: 'java-api', goldenPathVersion: '3', environments: ['dev'], costCenter: 'CC-1' },
  ...over,
});
const ctx = (runId = RUN) => ({ runId, user: 'jane@asterius.fr' });

beforeEach(async () => {
  ado = await fakeAdoGit({ 'services/_templates/team.yaml': TEMPLATE, 'README.md': '# portal' });
});
afterEach(async () => {
  await ado.close();
});

describe('Portal repo URL', () => {
  it('parses Azure DevOps repository URLs', () => {
    expect(parseRepoUrl('https://dev.azure.com/AsteriusIT/Platform/_git/portal-resources')).toMatchObject({
      org: 'AsteriusIT',
      project: 'Platform',
      repo: 'portal-resources',
      api: 'https://dev.azure.com/AsteriusIT/Platform/_apis/git/repositories/portal-resources',
    });
    expect(() => parseRepoUrl('https://dev.azure.com/AsteriusIT/Platform')).toThrow(/repository/);
    expect(() => parseRepoUrl('https://u:p@dev.azure.com/A/P/_git/r')).toThrow(/repository/);
  });
  it('recognizes stale pushes', () => {
    expect(isStalePush(new UpstreamError(409, 'x'))).toBe(true);
    expect(isStalePush(new UpstreamError(400, 'x', 'TF401028: the reference has already been updated'))).toBe(true);
    expect(isStalePush(new UpstreamError(400, 'x', 'bad request'))).toBe(false);
    expect(isStalePush(new Error('x'))).toBe(false);
  });
});

describe('commit queue', () => {
  it('creates the spec and the team folder in one commit, with the trailers', async () => {
    const out = await commitOperation(cfg(), ctx());
    expect(out).toMatchObject({ noop: false, attempts: 1, specPath: 'services/team-payments/payments-api.yaml', teamFileCreated: true, runIdLabel: RUN });
    expect(out.specUrl).toBe(`${ado.url}?path=${encodeURIComponent('/services/team-payments/payments-api.yaml')}&version=GBmain`);
    expect(out.commitUrl).toBe(`${ado.url}/commit/${out.commitId}`);
    expect(ado.head()).toBe(out.commitId);
    const commit = ado.commit(out.commitId)!;
    expect(commit.message).toBe(`Create payments/payments-api\n\nRun-Id: ${RUN}\nOn-Behalf-Of: jane@asterius.fr`);
    expect(ado.file('services/team-payments/team.yaml')).toContain('name: team-payments');
    const spec = YAML.parse(ado.file('services/team-payments/payments-api.yaml')!);
    expect(spec.metadata.annotations['portal.asterius.io/run-id']).toBe(RUN);
    expect(ado.pushes[0]!.auth).toBe(`Basic ${Buffer.from(':pat-123').toString('base64')}`);
    expect(ado.pushes[0]!.body.commits[0]!.changes.map((c) => [c.changeType, c.item.path])).toEqual([
      ['add', '/services/team-payments/team.yaml'],
      ['add', '/services/team-payments/payments-api.yaml'],
    ]);

    // second service of the team: no team file; same run again: no-op (retried step)
    const again = await commitOperation(cfg(), ctx());
    expect(again).toMatchObject({ noop: true, commitId: out.commitId });
    const second = await commitOperation(cfg({ service: 'ledger' }), ctx('bbbbbbbb-1111-4222-8333-444444444444'));
    expect(second.teamFileCreated).toBe(false);
    expect(ado.pushes.at(-1)!.body.commits[0]!.changes).toHaveLength(1);
  });

  it('refuses to create over a service another run created', async () => {
    await commitOperation(cfg(), ctx());
    await expect(commitOperation(cfg(), ctx('cccccccc-1111-4222-8333-444444444444'))).rejects.toThrow(/already exists/);
  });

  it('re-reads the head and re-plans when the branch moved under the push (stale oldObjectId → 409)', async () => {
    await commitOperation(cfg(), ctx());
    // While the pause is being pushed, someone edits the same spec by hand (costCenter) and commits first.
    ado.setOnPush((attempt) => {
      if (attempt === 2) {
        const current = ado.file('services/team-payments/payments-api.yaml')!;
        ado.commitDirect('services/team-payments/payments-api.yaml', current.replace('CC-1', 'CC-999'), 'manual fix');
      }
    });
    const logs: string[] = [];
    const out = await commitOperation(
      cfg({ operation: 'pause', pause: { until: '2h', reason: 'incident' } }),
      ctx('dddddddd-1111-4222-8333-444444444444'),
      async (m) => {
        logs.push(m);
      },
    );
    expect(out.attempts).toBe(2);
    expect(ado.pushes.map((p) => p.status)).toEqual([201, 409, 201]);
    // The retried push is based on the new head: the manual change is kept and the pause is applied on top.
    const spec = YAML.parse(ado.file('services/team-payments/payments-api.yaml')!);
    expect(spec.spec.costCenter).toBe('CC-999');
    expect(spec.metadata.annotations['portal.asterius.io/paused-reason']).toBe('incident');
    expect(ado.head()).toBe(out.commitId);
    expect(ado.commit(ado.commit(out.commitId)!.parent!)!.message).toBe('manual fix');
    expect(logs.join()).toMatch(/moved since/);
    expect(out.pausedReason).toBe('incident');
    expect(out.pausedUntil).toMatch(/Z$/);
  });

  it('gives up after a bounded number of conflicts', async () => {
    ado.setOnPush(() => {
      ado.commitDirect('README.md', `# ${Math.random()}`);
    });
    await expect(
      commitSerialized(
        { url: ado.url, branch: 'main', token: 't' },
        async () => ({ message: 'x', changes: [{ changeType: 'add', path: 'x.txt', content: 'x' }] }),
        {
          attempts: 3,
          backoffMs: 1,
        },
      ),
    ).rejects.toThrow(/409/);
    expect(ado.pushes.filter((p) => p.status === 409)).toHaveLength(3);
  });

  it('serializes concurrent writers in the process: pushes never overlap, all land', async () => {
    const services = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const outs = await Promise.all(services.map((s, i) => commitOperation(cfg({ service: s }), ctx(`eeeeeeee-1111-4222-8333-44444444444${i}`))));
    expect(ado.maxConcurrentPushes()).toBe(1);
    expect(ado.pushes.every((p) => p.status === 201)).toBe(true); // serialized: no conflict at all
    expect(outs.filter((o) => o.teamFileCreated)).toHaveLength(1);
    for (const s of services) expect(ado.file(`services/team-payments/${s}.yaml`)).toBeDefined();
  });

  it('waits for the lease another replica holds on the branch, and fails after waitMs', async () => {
    const name = 'v2-commit:org/Platform/portal-resources#main';
    await run('INSERT INTO ai_leases (name, locked_until) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', name, new Date(0).toISOString());
    await run('UPDATE ai_leases SET locked_until = ?, last_run_at = ? WHERE name = ?', later(400), 'holder:other-replica', name);
    const t0 = Date.now();
    const out = await commitOperation(cfg(), ctx());
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(out.noop).toBe(false);

    await run('UPDATE ai_leases SET locked_until = ?, last_run_at = ? WHERE name = ?', later(60_000), 'holder:other-replica', name);
    await expect(commitSerialized({ url: ado.url, branch: 'main', token: 't' }, async () => null, { waitMs: 200 })).rejects.toThrow(
      /another replica holds the lease/,
    );
    await run('UPDATE ai_leases SET locked_until = ? WHERE name = ?', new Date(0).toISOString(), name);
  });

  it('day-2 operations: missing spec fails, decommission is idempotent once removed', async () => {
    await expect(commitOperation(cfg({ operation: 'resume' }), ctx())).rejects.toThrow(/does not exist/);
    await commitOperation(cfg(), ctx());
    await expect(commitOperation(cfg({ operation: 'decommission' }), ctx())).rejects.toThrow(/decommission-run-id/);
    const mark = await commitOperation(cfg({ operation: 'mark-decommission' }), ctx());
    expect(ado.commit(mark.commitId)!.message).toMatch(/^Mark for decommission payments\/payments-api/);
    const removed = await commitOperation(cfg({ operation: 'decommission' }), ctx());
    expect(removed.removed).toBe(true);
    expect(ado.file('services/team-payments/payments-api.yaml')).toBeUndefined();
    expect(ado.pushes.at(-1)!.body.commits[0]!.changes).toEqual([{ changeType: 'delete', item: { path: '/services/team-payments/payments-api.yaml' } }]);
    expect((await commitOperation(cfg({ operation: 'decommission' }), ctx())).noop).toBe(true);
  });

  it('upgrade changes version and compositionRef in the committed file', async () => {
    await commitOperation(cfg(), ctx());
    const out = await commitOperation(cfg({ operation: 'upgrade', goldenPath: { version: 4 } }), ctx('ffffffff-1111-4222-8333-444444444444'));
    expect(out.goldenPath).toEqual({ name: 'java-api', version: '4' });
    const spec = YAML.parse(ado.file('services/team-payments/payments-api.yaml')!);
    expect(spec.spec.crossplane.compositionRef.name).toBe('java-api-v4');
    expect(ado.commit(out.commitId)!.message).toMatch(/^Upgrade payments\/payments-api\n\nRun-Id: ffffffff/);
  });

  it('a spec written by hand with comments keeps them through a pause', async () => {
    const m = renderServiceSpec({ team: 'payments', service: 'manual', inputs: cfg().inputs, runId: 'r', requestedBy: 'x' });
    ado.commitDirect('services/team-payments/manual.yaml', `# reviewed in PR 12\n${toYaml(m)}`);
    await commitOperation(cfg({ service: 'manual', operation: 'pause', pause: { until: '1h', reason: 'r' } }), ctx());
    expect(ado.file('services/team-payments/manual.yaml')!.startsWith('# reviewed in PR 12')).toBe(true);
  });
});
