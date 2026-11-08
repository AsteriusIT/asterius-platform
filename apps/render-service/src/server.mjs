// Plan / render service (docs/V2-KIND.md "Portal" → Preview, docs/V2-WRITE-SIDE.md): POST /render {service} answers
// {resources: [{kind, name, externalName, action}], raw} in one of two modes (RENDER_MODE):
//   tofu (default, lean path)   a real `tofu plan` of the Portal repo's root module against Azure DevOps with a
//                                throwaway local state (src/tofu.mjs): what will be created, and what exists and is adopted;
//   crossplane (optional)       the real `crossplane render` of the golden path against the Composition bundle mounted
//                                from ConfigMap portal-compositions, the functions running as sidecars of this pod.
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL, URL } from 'node:url';
import { functions, functionTargets, loadBundle, parseRenderOutput, RenderError, selectInputs, toYamlStream, xrds } from './render.mjs';
import { checkout, plan, schemaText, tofuReady, tofuSettings } from './tofu.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const DIR = process.env.COMPOSITIONS_DIR ?? '/compositions';
const BIN = process.env.CROSSPLANE_BIN ?? 'crossplane';
const TIMEOUT = process.env.RENDER_TIMEOUT ?? '60s';
const MAX_CONCURRENCY = Number(process.env.RENDER_MAX_CONCURRENCY ?? 2);
/** tofu | crossplane (read per request, so tests can switch). */
const mode = () => (process.env.RENDER_MODE ?? 'tofu').trim().toLowerCase();
const MAX_BODY = 1024 * 1024;

let running = 0;
const waiting = [];
async function limited(fn) {
  if (running >= MAX_CONCURRENCY) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });

/** One render in a private temp dir: xr.yaml, composition.yaml, functions.yaml (+ xrd.yaml for schema defaults). */
export async function render(service) {
  const bundle = await loadBundle(DIR);
  const { composition, functions: fns, xrd } = selectInputs(bundle, service);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'render-'));
  try {
    const xr = { ...service, metadata: { ...service.metadata } };
    await fs.writeFile(path.join(dir, 'xr.yaml'), toYamlStream([xr]));
    await fs.writeFile(path.join(dir, 'composition.yaml'), toYamlStream([composition]));
    await fs.writeFile(path.join(dir, 'functions.yaml'), toYamlStream(fns));
    const args = ['render', 'xr.yaml', 'composition.yaml', 'functions.yaml', `--timeout=${TIMEOUT}`, '--include-function-results'].map((a) =>
      a.endsWith('.yaml') ? path.join(dir, a) : a,
    );
    if (xrd) {
      await fs.writeFile(path.join(dir, 'xrd.yaml'), toYamlStream([xrd]));
      args.push(`--xrd=${path.join(dir, 'xrd.yaml')}`);
    }
    const res = await limited(() => run(BIN, args));
    if (res.code !== 0) throw new RenderError(422, `crossplane render failed: ${(res.stderr || res.stdout).trim().slice(0, 4000)}`);
    const out = parseRenderOutput(res.stdout, xr);
    // Same contract as the plan service: a composed resource is always to be created as far as the render knows.
    out.resources = out.resources.map((r) => ({ ...r, action: 'create' }));
    return { mode: 'crossplane', composition: composition.metadata.name, functions: fns.map((f) => f.metadata.name), ...out };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new RenderError(413, 'body too large');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new RenderError(400, 'invalid JSON');
  }
}

/** Are the function sidecars listening? (readiness: the pod serves renders only once they are up) */
async function sidecarsUp() {
  const { docs } = await loadBundle(DIR);
  const targets = Object.values(functionTargets(functions(docs)));
  const results = await Promise.all(
    targets.map(
      (t) =>
        new Promise((resolve) => {
          const [host, port] = t.replace(/^dns:\/\/\//, '').split(':');
          const s = net.connect({ host, port: Number(port) }, () => (s.destroy(), resolve(true)));
          s.on('error', () => resolve(false));
          s.setTimeout(1000, () => (s.destroy(), resolve(false)));
        }),
    ),
  );
  return { ok: results.every(Boolean), targets: Object.fromEntries(targets.map((t, i) => [t, results[i]])) };
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://render');
  const tofu = mode() !== 'crossplane';
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, mode: tofu ? 'tofu' : 'crossplane' });
    if (req.method === 'GET' && url.pathname === '/readyz') {
      const s = tofu ? await tofuReady() : await sidecarsUp();
      return send(res, s.ok ? 200 : 503, { mode: tofu ? 'tofu' : 'crossplane', ...s });
    }
    if (req.method === 'GET' && url.pathname === '/compositions') {
      if (tofu) return send(res, 404, { error: 'no Composition bundle in tofu mode (RENDER_MODE=crossplane)' });
      const { docs, files } = await loadBundle(DIR);
      return send(res, 200, {
        files,
        compositions: docs.filter((d) => d.kind === 'Composition').map((c) => ({ name: c.metadata?.name, labels: c.metadata?.labels ?? {} })),
        functions: docs.filter((d) => d.kind === 'Function').map((f) => f.metadata?.name),
        xrds: xrds(docs).map((x) => x.metadata?.name),
      });
    }
    // The Service schema as YAML: a form source for the portal (fromXrd.source: url).
    if (req.method === 'GET' && url.pathname === '/xrd') {
      if (tofu) return send(res, 200, await schemaText(), 'application/yaml');
      const kind = url.searchParams.get('kind');
      const list = xrds((await loadBundle(DIR)).docs)
        .filter((x) => !kind || x.spec?.names?.kind === kind)
        .map(({ __file: _f, ...x }) => x);
      if (!list.length) return send(res, 404, { error: 'no XRD in the bundle' });
      return send(res, 200, toYamlStream(list), 'application/yaml');
    }
    if (req.method === 'POST' && url.pathname === '/render') {
      const body = await readJson(req);
      return send(res, 200, tofu ? await limited(() => plan(body.service)) : await render(body.service));
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e instanceof RenderError ? e.status : 500;
    if (status >= 500) console.error(e.message);
    return send(res, status, { error: e.message });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  server.listen(PORT, () =>
    console.log(
      mode() === 'crossplane'
        ? `render service (crossplane) on :${PORT} (bundle ${DIR}, ${BIN})`
        : `plan service (tofu) on :${PORT} (${tofuSettings().repoUrl})`,
    ),
  );
  // Warm the Portal repo checkout so the first preview does not wait for the clone.
  if (mode() !== 'crossplane') checkout().catch((e) => console.error(`Portal repo: ${e.message}`));
  const stop = async () => {
    server.close();
    await delay(100);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
