import YAML, { isMap, type Document } from 'yaml';
import { ANN, DNS_LABEL, LABEL, labelSafeRunId, SERVICE_MAX, SERVICE_MIN, SERVICE_PATTERN, TEAM_MAX, TEAM_MIN, TEAM_PATTERN } from './labels.js';

/**
 * The Service spec written by the portal (docs/V2-KIND.md "Spec written by the portal"): rendered from form inputs on
 * create, and edited in place for day-2 operations (pause, resume, golden-path upgrade, decommission).
 */

export const API_VERSION = 'platform.asterius.io/v1alpha1';
export const KIND = 'Service';

/**
 * Form input name → path in `spec` (dot separated). Inputs generated from the XRD that have no entry here are named
 * `spec__<path with __>` (e.g. `spec__quality__qualityGate`), which maps back without configuration.
 */
export const DEFAULT_FIELDS: Record<string, string> = {
  goldenPath: 'goldenPath.name',
  goldenPathVersion: 'goldenPath.version',
  repositoryTemplate: 'repository.template',
  sonarqube: 'quality.sonarqube',
  qualityGate: 'quality.qualityGate',
  vaultSecrets: 'secrets.vault',
  environments: 'environments',
  costCenter: 'costCenter',
  onCall: 'onCall',
};
/** Spec fields the portal derives itself: never form fields. */
export const DERIVED_FIELDS = ['owner', 'crossplane'];
export const AUTO_PREFIX = 'spec__';

export const autoFieldName = (path: string) => `${AUTO_PREFIX}${path.split('.').join('__')}`;

export type ServiceManifest = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; annotations: Record<string, string>; labels: Record<string, string> };
  spec: Record<string, unknown>;
};

export const namespaceOf = (team: string) => `team-${team}`;
export const specPathOf = (team: string, service: string) => `services/team-${team}/${service}.yaml`;
export const teamPathOf = (team: string) => `services/team-${team}/team.yaml`;
export const TEAM_TEMPLATE_PATH = 'services/_templates/team.yaml';
/** `<goldenPath.name>-v<goldenPath.version>` (approved-composition policy). */
export const compositionRefOf = (name: string, version: string) => `${name}-v${version}`;

/** Team and service names: DNS labels within the Service schema limits (team 2–20, service 2–30 characters). */
export function checkNames(team: string, service: string) {
  if (!DNS_LABEL.test(team) || !new RegExp(TEAM_PATTERN).test(team))
    throw new Error(`team "${team}": ${TEAM_MIN}–${TEAM_MAX} lowercase letters, digits and - (starting with a letter, not ending with -)`);
  if (!DNS_LABEL.test(service) || !new RegExp(SERVICE_PATTERN).test(service))
    throw new Error(`service "${service}": ${SERVICE_MIN}–${SERVICE_MAX} lowercase letters, digits and - (starting with a letter, not ending with -)`);
}

const empty = (v: unknown) => v === undefined || v === null || v === '';

function setPath(o: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let cur = o;
  for (const p of parts.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== 'object' || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export const getPath = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((cur, p) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined), o);

/** Map of every input that lands in the spec: the configured fields plus `spec__…` inputs. */
export function specFieldsOf(inputs: Record<string, unknown>, fields: Record<string, string> = DEFAULT_FIELDS): [string, string][] {
  const out: [string, string][] = Object.entries(fields);
  for (const k of Object.keys(inputs))
    if (k.startsWith(AUTO_PREFIX) && !out.some(([n]) => n === k)) out.push([k, k.slice(AUTO_PREFIX.length).split('__').join('.')]);
  return out.filter(([, path]) => !DERIVED_FIELDS.includes(path.split('.')[0]!));
}

/** The intent part of the spec from form inputs (no owner / crossplane block). */
export function specFromInputs(inputs: Record<string, unknown>, fields: Record<string, string> = DEFAULT_FIELDS): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  for (const [name, path] of specFieldsOf(inputs, fields)) {
    let v = inputs[name];
    if (empty(v)) continue;
    if (path === 'goldenPath.version') v = String(v);
    setPath(spec, path, v);
  }
  return spec;
}

export interface RenderSpecInput {
  team: string;
  service: string;
  inputs: Record<string, unknown>;
  runId: string;
  requestedBy: string;
  fields?: Record<string, string>;
}

/** Contract key order: owner, goldenPath, repository, quality, secrets, environments, costCenter, onCall, others…, crossplane. */
function ordered(spec: Record<string, unknown>, team: string): Record<string, unknown> {
  const gp = spec.goldenPath as { name?: string; version?: string } | undefined;
  if (!gp?.name || !gp.version) throw new Error('goldenPath.name and goldenPath.version are required');
  const order = ['goldenPath', 'repository', 'quality', 'secrets', 'environments', 'costCenter', 'onCall'];
  const out: Record<string, unknown> = { owner: team };
  for (const k of order) if (spec[k] !== undefined) out[k] = spec[k];
  for (const [k, v] of Object.entries(spec)) if (!(k in out) && !DERIVED_FIELDS.includes(k)) out[k] = v;
  const cp = (spec.crossplane as Record<string, unknown> | undefined) ?? {};
  out.crossplane = { ...cp, compositionRef: { name: compositionRefOf(gp.name, String(gp.version)) }, compositionUpdatePolicy: 'Manual' };
  return out;
}

const isProd = (spec: Record<string, unknown>) => Array.isArray(spec.environments) && spec.environments.includes('prod');

/** The manifest of a new service. */
export function renderServiceSpec(i: RenderSpecInput): ServiceManifest {
  checkNames(i.team, i.service);
  const spec = ordered(specFromInputs(i.inputs, i.fields), i.team);
  return {
    apiVersion: API_VERSION,
    kind: KIND,
    metadata: {
      name: i.service,
      namespace: namespaceOf(i.team),
      annotations: { [ANN.runId]: i.runId, [ANN.requestedBy]: i.requestedBy },
      labels: {
        [LABEL.team]: i.team,
        [LABEL.service]: i.service,
        [LABEL.runId]: labelSafeRunId(i.runId),
        ...(isProd(spec) ? { [LABEL.protected]: 'true' } : {}),
      },
    },
    spec,
  };
}

export const toYaml = (m: unknown) => YAML.stringify(m, { lineWidth: 0 });

// ---------- day-2 edits on an existing file (comments and layout outside the edited keys are kept) ----------

export type Operation = 'create' | 'update' | 'pause' | 'resume' | 'upgrade' | 'mark-decommission' | 'decommission';
export const OPERATIONS: Operation[] = ['create', 'update', 'pause', 'resume', 'upgrade', 'mark-decommission', 'decommission'];
export const VERBS: Record<Operation, string> = {
  create: 'Create',
  update: 'Update',
  pause: 'Pause',
  resume: 'Resume',
  upgrade: 'Upgrade',
  'mark-decommission': 'Mark for decommission',
  decommission: 'Decommission',
};

export interface EditInput {
  runId: string;
  requestedBy: string;
  inputs?: Record<string, unknown>;
  fields?: Record<string, string>;
  pause?: { until: string; reason: string };
  goldenPath?: { name?: string; version: string };
}

export function parseManifest(text: string): Document {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`invalid YAML: ${doc.errors[0]!.message}`);
  if (!isMap(doc.contents) || doc.get('kind') !== KIND) throw new Error(`not a ${KIND} manifest`);
  return doc;
}

/** Run id annotation and label: every change records the run that made it. */
function stamp(doc: Document, runId: string) {
  doc.setIn(['metadata', 'annotations', ANN.runId], runId);
  doc.setIn(['metadata', 'labels', LABEL.runId], labelSafeRunId(runId));
}

const MAX_PAUSE_MS = 30 * 86400_000;

/** `2026-11-09T10:00:00Z`, or a duration from now (`30m`, `4h`, `2d`). Must be in the future and at most 30 days away. */
export function pauseExpiry(until: string, nowMs = Date.now()): string {
  const d = /^(\d{1,5})([mhd])$/.exec(until.trim());
  const ms = d ? nowMs + Number(d[1]) * { m: 60_000, h: 3600_000, d: 86400_000 }[d[2] as 'm' | 'h' | 'd'] : Date.parse(until);
  if (Number.isNaN(ms)) throw new Error(`pause: "${until}" is neither an RFC 3339 date-time nor a duration (30m, 4h, 2d)`);
  if (ms <= nowMs) throw new Error('pause: the expiry must be in the future');
  if (ms - nowMs > MAX_PAUSE_MS) throw new Error('pause: at most 30 days');
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function deleteAnnotation(doc: Document, key: string) {
  if (doc.hasIn(['metadata', 'annotations', key])) doc.deleteIn(['metadata', 'annotations', key]);
}

/**
 * Apply a day-2 operation to the current file. Returns the new text, or `null` for "delete the file" (decommission).
 * Throws when the operation is not allowed in the file's current state.
 */
export function editSpec(text: string, op: Exclude<Operation, 'create'>, e: EditInput): string | null {
  const doc = parseManifest(text);
  switch (op) {
    case 'update': {
      const current = (doc.toJS() as ServiceManifest).spec ?? {};
      const team = String(doc.getIn(['metadata', 'labels', LABEL.team]) ?? current.owner ?? '');
      const merged = mergeDeep(current, specFromInputs(e.inputs ?? {}, e.fields));
      const spec = ordered(merged, team);
      doc.setIn(['spec'], doc.createNode(spec));
      if (isProd(spec)) doc.setIn(['metadata', 'labels', LABEL.protected], 'true');
      else if (doc.hasIn(['metadata', 'labels', LABEL.protected])) doc.deleteIn(['metadata', 'labels', LABEL.protected]);
      break;
    }
    case 'pause': {
      if (!e.pause?.reason?.trim()) throw new Error('pause: a reason is required');
      doc.setIn(['metadata', 'annotations', ANN.paused], pauseExpiry(e.pause.until));
      doc.setIn(['metadata', 'annotations', ANN.pausedReason], e.pause.reason.trim());
      break;
    }
    case 'resume':
      deleteAnnotation(doc, ANN.paused);
      deleteAnnotation(doc, ANN.pausedReason);
      break;
    case 'upgrade': {
      const version = e.goldenPath?.version !== undefined ? String(e.goldenPath.version) : '';
      if (!version) throw new Error('upgrade: goldenPath.version is required');
      const name = e.goldenPath?.name || String(doc.getIn(['spec', 'goldenPath', 'name']) ?? '');
      if (!name) throw new Error('upgrade: the spec has no goldenPath.name');
      doc.setIn(['spec', 'goldenPath', 'name'], name);
      doc.setIn(['spec', 'goldenPath', 'version'], version);
      doc.setIn(['spec', 'crossplane', 'compositionRef', 'name'], compositionRefOf(name, version));
      doc.setIn(['spec', 'crossplane', 'compositionUpdatePolicy'], 'Manual');
      break;
    }
    case 'mark-decommission':
      doc.setIn(['metadata', 'annotations', ANN.decommissionRunId], e.runId);
      break;
    case 'decommission':
      if (!doc.hasIn(['metadata', 'annotations', ANN.decommissionRunId]))
        throw new Error(`decommission: the spec has no ${ANN.decommissionRunId} annotation; run the mark-decommission operation first`);
      return null;
  }
  stamp(doc, e.runId);
  return doc.toString({ lineWidth: 0 });
}

function mergeDeep(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)
        ? mergeDeep(cur as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

/** Team folder manifest from the template of the Portal repo (`<team>` is the only placeholder), or a built-in default. */
export function renderTeamFile(team: string, template: string | null): string {
  if (template) return template.replace(/<team>|\{\{\s*team\s*\}\}/g, team);
  const ns = namespaceOf(team);
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels: { [LABEL.team]: team } } },
    {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: { name: 'team-quota', namespace: ns, labels: { [LABEL.team]: team } },
      spec: { hard: { 'count/services.platform.asterius.io': '50' } },
    },
  ]
    .map(toYaml)
    .join('---\n');
}

/** Commit message: `<verb> <team>/<service>` and the audit trailers. */
export const commitMessage = (op: Operation, team: string, service: string, runId: string, onBehalfOf: string) =>
  `${VERBS[op]} ${team}/${service}\n\nRun-Id: ${runId}\nOn-Behalf-Of: ${onBehalfOf}`;
