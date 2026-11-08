// Plan service (docs/V2-KIND.md "Portal" → Preview): POST /render {service} runs a real `tofu plan` of the Portal repo's
// root module against Azure DevOps with a throwaway local state, so the preview shows what would be created and what
// already exists and would be adopted (import blocks). Read-only: never runs apply, the state is a temp file.
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import YAML from 'yaml';
import { RenderError } from './render.mjs';

const DNS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Environment of the plan service (read once per call, so tests can change it). */
export function tofuSettings(env = process.env) {
  const org = (env.ADO_ORG_URL ?? 'https://dev.azure.com/AsteriusIT').replace(/\/+$/, '');
  return {
    bin: env.TOFU_BIN ?? 'tofu',
    git: env.GIT_BIN ?? 'git',
    repoUrl: env.REPO_URL ?? 'https://dev.azure.com/AsteriusIT/Platform/_git/portal-resources',
    branch: env.REPO_BRANCH ?? 'main',
    /** A checkout to use as is (no clone, no refresh): tests and local runs. */
    repoDir: env.REPO_DIR || null,
    cacheDir: env.REPO_CACHE_DIR ?? path.join(os.tmpdir(), 'portal-resources'),
    refreshMs: Number(env.REPO_REFRESH_SECONDS ?? 60) * 1000,
    root: (env.TOFU_ROOT ?? 'tofu/service').replace(/^\/+|\/+$/g, ''),
    specVar: env.TOFU_SPEC_VAR ?? 'spec_path',
    /** Extra `-var` values, `k=v,k2=v2`. */
    extraVars: String(env.TOFU_EXTRA_VARS ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.includes('=')),
    timeoutMs: Number(env.PLAN_TIMEOUT_SECONDS ?? 120) * 1000,
    pluginCache: env.TF_PLUGIN_CACHE_DIR ?? '',
    schemaPath: env.SCHEMA_PATH ?? 'schema/service-xrd.yaml',
    pat: env.ADO_PAT ?? '',
    org,
  };
}

const run = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr, killed: !!err?.killed }),
    );
  });

/** Never echo a credential: the PAT (and its Basic form) are masked in every message. */
export function redact(text, s) {
  let out = String(text ?? '');
  if (s.pat) {
    out = out.split(s.pat).join('***');
    out = out.split(Buffer.from(`:${s.pat}`).toString('base64')).join('***');
  }
  return out;
}

// ---------- Portal repo checkout (cached shallow clone, refreshed at most every REPO_REFRESH_SECONDS) ----------

const repoState = { at: 0, commit: null, error: null, pending: null };
export const repoStatus = () => ({ commit: repoState.commit, refreshedAt: repoState.at ? new Date(repoState.at).toISOString() : null, error: repoState.error });
/** Tests: forget the cached checkout state. */
export const resetRepo = () => Object.assign(repoState, { at: 0, commit: null, error: null, pending: null });

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: process.env.HOME ?? os.tmpdir() });
/** The PAT goes in an http.extraHeader for the one command (never in the remote URL or .git/config). */
const authArgs = (s) =>
  s.pat && /^https:/i.test(s.repoUrl) ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`:${s.pat}`).toString('base64')}`] : [];

async function git(s, args, cwd) {
  const r = await run(s.git, [...authArgs(s), ...args], { cwd, env: gitEnv(), timeout: 60_000 });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${redact((r.stderr || r.stdout).trim(), s).slice(0, 1000)}`);
  return r.stdout.trim();
}

async function refresh(s) {
  const dir = s.cacheDir;
  const exists = await fs.stat(path.join(dir, '.git')).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await git(s, ['clone', '--depth', '1', '--single-branch', '--branch', s.branch, s.repoUrl, dir]);
  } else {
    await git(s, ['fetch', '--depth', '1', 'origin', s.branch], dir);
    await git(s, ['reset', '--hard', '--quiet', 'FETCH_HEAD'], dir);
  }
  return git(s, ['rev-parse', 'HEAD'], dir);
}

/**
 * The checkout to plan from: REPO_DIR as is, else the cached clone of REPO_URL#REPO_BRANCH, refreshed when older than
 * REPO_REFRESH_SECONDS (concurrent callers share one refresh). A failed refresh keeps serving the last good checkout.
 */
export async function checkout(s = tofuSettings()) {
  if (s.repoDir) return { dir: s.repoDir, commit: null };
  if (Date.now() - repoState.at >= s.refreshMs || !repoState.commit) {
    repoState.pending ??= refresh(s)
      .then((commit) => Object.assign(repoState, { commit, error: null }))
      .catch((e) => {
        repoState.error = e.message;
      })
      .finally(() => {
        repoState.at = Date.now();
        repoState.pending = null;
      });
    await repoState.pending;
  }
  if (!repoState.commit) throw new RenderError(503, `Portal repo not available: ${repoState.error ?? 'not cloned yet'}`);
  return { dir: s.cacheDir, commit: repoState.commit };
}

// ---------- plan JSON → preview contract ----------

/**
 * `tofu show -json` of a plan → `[{kind, name, externalName, action}]`: kind = resource type, name = address,
 * externalName = the `name` attribute when known, action = create | import | update | delete | no-op
 * (a resource being imported is `import`: it already exists and will be adopted; a replacement is `update`
 * with `replace: true`). Data sources and outputs are left out.
 */
export function mapPlan(plan) {
  const changes = Array.isArray(plan?.resource_changes) ? plan.resource_changes : [];
  return changes
    .filter((rc) => rc && rc.mode !== 'data')
    .map((rc) => {
      const c = rc.change ?? {};
      const actions = Array.isArray(c.actions) ? c.actions : [];
      const replace = actions.includes('create') && actions.includes('delete');
      let action;
      if (c.importing) action = 'import';
      else if (replace) action = 'update';
      else if (actions.includes('create')) action = 'create';
      else if (actions.includes('delete')) action = 'delete';
      else if (actions.includes('update')) action = 'update';
      else action = 'no-op';
      const known = (o) => (o && typeof o === 'object' && typeof o.name === 'string' && o.name ? o.name : null);
      const unknownName = !!(c.after_unknown && c.after_unknown.name === true);
      const externalName = (unknownName ? null : known(c.after)) ?? known(c.before) ?? null;
      return {
        kind: rc.type,
        name: rc.address,
        externalName,
        action,
        ...(replace ? { replace: true } : {}),
        ...(c.importing?.id ? { importId: String(c.importing.id) } : {}),
      };
    });
}

// ---------- plan ----------

function validateService(service) {
  if (!service || typeof service !== 'object' || !service.kind || !service.apiVersion || !service.metadata?.name)
    throw new RenderError(400, 'body.service must be a manifest (apiVersion, kind, metadata.name)');
  const name = String(service.metadata.name);
  const team = String(
    service.metadata.labels?.['portal.asterius.io/team'] ?? service.spec?.owner ?? String(service.metadata.namespace ?? '').replace(/^team-/, ''),
  );
  if (!DNS.test(name) || name.length > 63) throw new RenderError(400, `invalid service name "${name}"`);
  if (!DNS.test(team) || team.length > 63) throw new RenderError(400, `invalid team "${team}"`);
  return { team, name };
}

/** `-backend=false` is not enough for `plan`: the backend is overridden by a local one with a throwaway state. */
const BACKEND_OVERRIDE = (state) => `# Written by the plan service: throwaway local state, never the shared backend.
terraform {
  backend "local" {
    path = ${JSON.stringify(state)}
  }
}
`;

/**
 * One plan in a private temp dir: a copy of the checkout with the spec at services/team-<team>/<service>.yaml, the
 * backend overridden to a local empty state, `tofu init` + `tofu plan -out` + `tofu show -json`. Read only.
 */
export async function plan(service, s = tofuSettings()) {
  const { team, name } = validateService(service);
  const deadline = Date.now() + s.timeoutMs;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new RenderError(504, `tofu plan timed out after ${Math.round(s.timeoutMs / 1000)}s`);
    return ms;
  };
  const repo = await checkout(s);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-'));
  try {
    const tree = path.join(work, 'repo');
    await fs.cp(repo.dir, tree, { recursive: true, filter: (src) => path.basename(src) !== '.git' && path.basename(src) !== '.terraform' });
    const root = path.join(tree, s.root);
    if (!(await fs.stat(root).catch(() => null))?.isDirectory()) throw new RenderError(503, `the Portal repo has no OpenTofu root module ${s.root}/`);
    const specFile = path.join(tree, 'services', `team-${team}`, `${name}.yaml`);
    await fs.mkdir(path.dirname(specFile), { recursive: true });
    await fs.writeFile(specFile, YAML.stringify(service, { lineWidth: 0 }));
    await fs.writeFile(path.join(root, 'zz_plan_service_override.tf'), BACKEND_OVERRIDE(path.join(work, 'plan.tfstate')));
    const env = {
      ...process.env,
      TF_IN_AUTOMATION: '1',
      TF_INPUT: '0',
      CHECKPOINT_DISABLE: '1',
      HOME: process.env.HOME ?? work,
      ...(s.pluginCache ? { TF_PLUGIN_CACHE_DIR: s.pluginCache, TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: '1' } : {}),
      ...(s.pat ? { AZDO_PERSONAL_ACCESS_TOKEN: s.pat, AZDO_ORG_SERVICE_URL: s.org } : {}),
    };
    const tofu = async (args, step) => {
      const r = await run(s.bin, args, { cwd: root, env, timeout: left() });
      if (r.killed && Date.now() >= deadline) throw new RenderError(504, `tofu ${step} timed out after ${Math.round(s.timeoutMs / 1000)}s`);
      if (r.code !== 0) throw new RenderError(422, `tofu ${step} failed: ${redact((r.stderr || r.stdout).trim(), s).slice(0, 4000)}`);
      return r.stdout;
    };
    if (s.pluginCache) await fs.mkdir(s.pluginCache, { recursive: true }).catch(() => undefined); // tofu ignores a missing cache dir
    await tofu(['init', '-input=false', '-no-color', '-reconfigure'], 'init');
    const vars = [`${s.specVar}=${specFile}`, ...s.extraVars].flatMap((v) => ['-var', v]);
    await tofu(['plan', '-input=false', '-no-color', '-lock=false', '-out=plan.bin', ...vars], 'plan');
    const shown = await tofu(['show', '-json', '-no-color', 'plan.bin'], 'show');
    let json;
    try {
      json = JSON.parse(shown);
    } catch {
      throw new RenderError(422, 'tofu show -json did not return JSON');
    }
    return {
      mode: 'tofu',
      commit: repo.commit,
      root: s.root,
      resources: mapPlan(json),
      raw: Array.isArray(json.resource_changes) ? json.resource_changes : [],
      ...(json.terraform_version ? { tofuVersion: json.terraform_version } : {}),
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** The Service schema file of the checkout (a `fromXrd` url source for the portal). */
export async function schemaText(s = tofuSettings()) {
  const repo = await checkout(s);
  const file = path.join(repo.dir, s.schemaPath);
  if (!path.resolve(file).startsWith(path.resolve(repo.dir) + path.sep)) throw new RenderError(400, 'bad SCHEMA_PATH');
  return fs.readFile(file, 'utf8').catch(() => {
    throw new RenderError(404, `${s.schemaPath} not found in the Portal repo`);
  });
}

/** Readiness: the tofu binary answers (and the checkout was obtained once, when a repository is configured). */
export async function tofuReady(s = tofuSettings()) {
  if (s.pluginCache) await fs.mkdir(s.pluginCache, { recursive: true }).catch(() => undefined);
  const v = await run(s.bin, ['version', '-json'], { timeout: 10_000 });
  let version;
  try {
    version = JSON.parse(v.stdout).terraform_version ?? null;
  } catch {
    version = v.stdout.trim().split('\n')[0] || null;
  }
  return { ok: v.code === 0, tofu: version, repo: s.repoDir ? { dir: s.repoDir } : repoStatus() };
}
