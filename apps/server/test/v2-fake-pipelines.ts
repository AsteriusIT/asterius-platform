import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process fake of the Azure DevOps Pipelines / Build REST API used by the V2 lean path: pipeline lookup by name
 * (`_apis/build/definitions?name=`), queueing (`_apis/pipelines/{id}/runs`), run status, logs, the `outputs` artifact,
 * the build timeline and the list of builds of a pipeline (drift feed). Organization path: `/org`.
 */
export interface FakeRun {
  id: number;
  project: string;
  pipelineId: number;
  templateParameters: Record<string, string>;
  polls: number;
  result: 'succeeded' | 'failed';
}

export interface FakeBuild {
  id: number;
  definition: number;
  finishTime: string;
  tags: string[];
}

export async function fakeAdoPipelines(opts: { definitions?: Record<string, Record<string, number>> } = {}) {
  /** project → pipeline name → id */
  const definitions: Record<string, Record<string, number>> = opts.definitions ?? {
    Platform: { 'portal-services-apply': 11, 'portal-operations': 12, 'portal-services-drift': 13 },
  };
  const runs: FakeRun[] = [];
  const builds: FakeBuild[] = [];
  const calls: string[] = [];
  let next = 100;
  /** Outcome of a queued run (default: succeeded). */
  let outcome: (r: Omit<FakeRun, 'polls' | 'result' | 'id'>) => 'succeeded' | 'failed' = () => 'succeeded';
  /** Polls before a run completes. */
  let pollsToComplete = 1;
  let outputs: (r: FakeRun) => unknown = (r) => ({
    projectId: 'p-guid',
    projectUrl: `https://dev.azure.com/AsteriusIT/${r.templateParameters.service?.replace('/', '-')}`,
    repoUrl: `https://dev.azure.com/AsteriusIT/${r.templateParameters.service?.replace('/', '-')}/_git/${r.templateParameters.service?.split('/')[1]}`,
    pipelineId: 77,
    pipelineUrl: 'https://dev.azure.com/AsteriusIT/x/_build?definitionId=77',
  });
  let url = '';

  const runView = (r: FakeRun) => ({
    id: r.id,
    state: r.polls >= pollsToComplete ? 'completed' : 'inProgress',
    ...(r.polls >= pollsToComplete ? { result: r.result } : {}),
    _links: { web: { href: `${url}/org/${encodeURIComponent(r.project)}/_build/results?buildId=${r.id}` } },
  });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      calls.push(`${req.method} ${u.pathname}${u.search}`);
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const m = /^\/org\/([^/]+)\/_apis\/(.+)$/.exec(u.pathname);
      if (!m) return send(404, { message: 'not found' });
      const project = decodeURIComponent(m[1]!);
      const rest = m[2]!;
      if (rest === 'build/definitions') {
        const name = u.searchParams.get('name') ?? '';
        const id = definitions[project]?.[name];
        return send(200, { value: id ? [{ id, name, path: '\\' }] : [] });
      }
      let x = /^pipelines\/(\d+)\/runs$/.exec(rest);
      if (x && req.method === 'POST') {
        const pipelineId = Number(x[1]);
        if (!Object.values(definitions[project] ?? {}).includes(pipelineId)) return send(404, { message: 'pipeline not found' });
        const body = JSON.parse(raw || '{}') as { templateParameters?: Record<string, string> };
        const base = { project, pipelineId, templateParameters: body.templateParameters ?? {} };
        const r: FakeRun = { id: ++next, ...base, polls: 0, result: outcome(base) };
        runs.push(r);
        return send(200, runView(r));
      }
      x = /^pipelines\/(\d+)\/runs\/(\d+)$/.exec(rest);
      if (x) {
        const r = runs.find((y) => y.id === Number(x![2]));
        if (!r) return send(404, {});
        r.polls++;
        return send(200, runView(r));
      }
      if (/^pipelines\/\d+\/runs\/\d+\/logs$/.test(rest)) return send(200, { logs: [] });
      x = /^build\/builds\/(\d+)\/artifacts$/.exec(rest);
      if (x) {
        const r = runs.find((y) => y.id === Number(x![1]));
        if (!r) return send(404, {});
        if (u.searchParams.get('$format') === 'file') return send(200, outputs(r));
        return send(200, {
          name: 'outputs',
          resource: { downloadUrl: `${url}/org/${m[1]}/_apis/build/builds/${r.id}/artifacts?artifactName=outputs&api-version=7.1&%24format=zip` },
        });
      }
      x = /^build\/builds\/(\d+)\/timeline$/.exec(rest);
      if (x) {
        const r = runs.find((y) => y.id === Number(x![1]));
        if (!r) return send(404, {});
        const t0 = Date.now() - 30_000;
        const iso = (s: number) => new Date(t0 + s * 1000).toISOString();
        const failed = r.result === 'failed';
        return send(200, {
          records: [
            { id: 's1', type: 'Stage', name: 'plan', state: 'completed', result: 'succeeded', startTime: iso(0), finishTime: iso(8) },
            { id: 'j1', parentId: 's1', type: 'Job', name: 'plan', state: 'completed', result: 'succeeded', startTime: iso(1), finishTime: iso(7) },
            {
              id: 't1',
              parentId: 'j1',
              type: 'Task',
              name: 'tofu apply',
              state: 'completed',
              result: failed ? 'failed' : 'succeeded',
              startTime: iso(9),
              finishTime: iso(15),
              issues: failed ? [{ type: 'error', message: 'TF401019: project name already taken' }] : [],
            },
            { id: 'c1', type: 'Checkpoint', name: 'Checkpoint', state: 'completed', result: 'succeeded', startTime: iso(0), finishTime: iso(0) },
            { id: 'p1', type: 'Task', name: 'not run yet', state: 'pending' },
          ],
        });
      }
      if (rest === 'build/builds') {
        const def = Number(u.searchParams.get('definitions'));
        return send(200, { value: builds.filter((b) => b.definition === def).sort((a, b) => Date.parse(b.finishTime) - Date.parse(a.finishTime)) });
      }
      return send(404, { message: `no route ${rest}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    org: `${url}/org`,
    runs,
    builds,
    calls,
    definitions,
    setOutcome: (f: typeof outcome) => (outcome = f),
    setPollsToComplete: (n: number) => (pollsToComplete = n),
    setOutputs: (f: typeof outputs) => (outputs = f),
    close: () => new Promise((r) => server.close(r)),
  };
}
