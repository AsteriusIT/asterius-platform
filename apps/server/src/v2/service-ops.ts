import YAML from 'yaml';
import { z } from 'zod';
import { commitSerialized, commitUrl, fileUrl, readFile, type Change, type CommitResult, type PortalRepo } from './ado-git.js';
import { ANN, labelSafeRunId } from './labels.js';
import {
  checkNames,
  commitMessage,
  editSpec,
  OPERATIONS,
  renderServiceSpec,
  renderTeamFile,
  specPathOf,
  TEAM_TEMPLATE_PATH,
  teamPathOf,
  toYaml,
  type ServiceManifest,
} from './spec.js';

/** Configuration shared by the `service-spec` (commit) and `service-precheck` invokers, once rendered. */
export const serviceOpConfig = z.object({
  /** Portal repo web URL: https://dev.azure.com/<org>/<project>/_git/<repo>. */
  repository: z.string().min(1),
  branch: z.string().min(1).max(200).default('main'),
  /** `${secret:ADO_PAT}` / `${env:ADO_PAT}`: PAT with Code (Read & write), or `Bearer <Entra token>`. */
  token: z.string().default(''),
  operation: z.enum(OPERATIONS as [string, ...string[]]).default('create'),
  // Loose here: checkNames reports the exact limits as a portal-spec violation (shown in the preview).
  team: z.string().min(1).max(63),
  service: z.string().min(1).max(63),
  /** create / update: the form values (`{{ inputs }}`). */
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Input name → spec path; default: the contract mapping (spec.ts DEFAULT_FIELDS). */
  fields: z.record(z.string(), z.string()).optional(),
  /** pause: RFC 3339 expiry or a duration (`4h`), and a reason. */
  pause: z.object({ until: z.string().min(1), reason: z.string().min(1).max(500) }).optional(),
  /** upgrade: the target golden path (name defaults to the current one). */
  goldenPath: z.object({ name: z.string().optional(), version: z.union([z.string().min(1), z.number()]) }).optional(),
  /** Requester email (annotation and On-Behalf-Of trailer); default: the user who started the run. */
  requestedBy: z.string().optional(),
});
export type ServiceOpConfig = z.infer<typeof serviceOpConfig>;

export interface OpContext {
  runId: string;
  user: string;
}

export const repoOf = (c: ServiceOpConfig): PortalRepo => ({ url: c.repository, branch: c.branch, token: c.token });

const editInput = (c: ServiceOpConfig, ctx: OpContext) => ({
  runId: ctx.runId,
  requestedBy: c.requestedBy || ctx.user,
  inputs: c.inputs,
  fields: c.fields,
  pause: c.pause,
  goldenPath: c.goldenPath ? { name: c.goldenPath.name, version: String(c.goldenPath.version) } : undefined,
});

export interface NextState {
  path: string;
  /** Current file content (null: absent). */
  before: string | null;
  /** New content (null: the file is removed). */
  after: string | null;
  /** The manifest to evaluate: the new one, or the current one marked for deletion. */
  manifest: ServiceManifest | null;
}

/**
 * The spec after the operation, computed from a reader (branch head or a given commit). Throws when the operation is
 * impossible (create over another run's file, day-2 on a missing file, decommission without the annotation).
 */
export async function nextState(c: ServiceOpConfig, ctx: OpContext, read: (path: string) => Promise<string | null>): Promise<NextState> {
  checkNames(c.team, c.service);
  const path = specPathOf(c.team, c.service);
  const op = c.operation as (typeof OPERATIONS)[number];
  if (op === 'create') {
    const manifest = renderServiceSpec({
      team: c.team,
      service: c.service,
      inputs: c.inputs,
      runId: ctx.runId,
      requestedBy: c.requestedBy || ctx.user,
      fields: c.fields,
    });
    const before = await read(path);
    if (before !== null) {
      const existing = YAML.parse(before) as ServiceManifest | null;
      if (existing?.metadata?.annotations?.[ANN.runId] !== ctx.runId)
        throw new Error(`${path} already exists (created by run ${existing?.metadata?.annotations?.[ANN.runId] ?? 'unknown'}); use an update action`);
      return { path, before, after: before, manifest: existing };
    }
    return { path, before: null, after: toYaml(manifest), manifest };
  }
  const before = await read(path);
  if (before === null) {
    if (op === 'decommission') return { path, before, after: null, manifest: null };
    throw new Error(`${path} does not exist in the Portal repo`);
  }
  const after = editSpec(before, op, editInput(c, ctx));
  return { path, before, after, manifest: YAML.parse(after ?? before) as ServiceManifest };
}

export interface CommitOutput {
  operation: string;
  commitId: string;
  commitUrl: string;
  specPath: string;
  specUrl: string;
  /** No commit was needed (already in the desired state, e.g. a retried step). */
  noop: boolean;
  attempts: number;
  runId: string;
  runIdLabel: string;
  teamFileCreated: boolean;
  /** State after the operation, for later steps (catalog properties). */
  pausedUntil: string | null;
  pausedReason: string | null;
  goldenPath: { name: string; version: string } | null;
  removed: boolean;
}

/** Write the operation to the Portal repo through the serialized commit queue. */
export async function commitOperation(c: ServiceOpConfig, ctx: OpContext, log?: (m: string) => Promise<void>): Promise<CommitOutput> {
  if (!c.token) throw new Error('service-spec: token is required (${secret:ADO_PAT} or ${env:ADO_PAT})');
  const repo = repoOf(c);
  let teamFileCreated = false;
  let state: NextState | undefined;
  const res: CommitResult = await commitSerialized(
    repo,
    async (read) => {
      teamFileCreated = false;
      const s = await nextState(c, ctx, read);
      state = s;
      if (s.after === s.before) return null;
      const changes: Change[] = [];
      if (s.after === null) changes.push({ changeType: 'delete', path: s.path });
      else changes.push({ changeType: s.before === null ? 'add' : 'edit', path: s.path, content: s.after });
      if (c.operation === 'create' && (await read(teamPathOf(c.team))) === null) {
        changes.unshift({ changeType: 'add', path: teamPathOf(c.team), content: renderTeamFile(c.team, await read(TEAM_TEMPLATE_PATH)) });
        teamFileCreated = true;
      }
      return { message: commitMessage(c.operation as (typeof OPERATIONS)[number], c.team, c.service, ctx.runId, c.requestedBy || ctx.user), changes };
    },
    { log },
  );
  const path = specPathOf(c.team, c.service);
  return {
    operation: c.operation,
    commitId: res.commitId,
    commitUrl: commitUrl(repo, res.commitId),
    specPath: path,
    specUrl: fileUrl(repo, path),
    noop: res.noop,
    attempts: res.attempts,
    runId: ctx.runId,
    runIdLabel: labelSafeRunId(ctx.runId),
    teamFileCreated: res.noop ? false : teamFileCreated,
    ...summary(state),
  };
}

function summary(s: NextState | undefined) {
  const m = s?.after ? (YAML.parse(s.after) as ServiceManifest) : null;
  const ann = m?.metadata?.annotations ?? {};
  const gp = m?.spec?.goldenPath as { name?: string; version?: string } | undefined;
  return {
    pausedUntil: ann[ANN.paused] ?? null,
    pausedReason: ann[ANN.pausedReason] ?? null,
    goldenPath: gp?.name ? { name: gp.name, version: String(gp.version ?? '') } : null,
    removed: !!s && s.after === null,
  };
}

/**
 * The next state against the branch head, without writing (pre-check and preview). Create only reads the repo when
 * a token is configured (to report an existing service early); day-2 operations need it.
 */
export async function previewState(c: ServiceOpConfig, ctx: OpContext): Promise<NextState> {
  if (c.operation === 'create' && !c.token) return nextState(c, ctx, async () => null);
  if (!c.token) throw new Error('reading the current spec needs the Portal repo token');
  const repo = repoOf(c);
  return nextState(c, ctx, (p) => readFile(repo, p));
}
