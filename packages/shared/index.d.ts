/**
 * Types shared by the Asterius Platform server and web UI (API shapes).
 * Declarations only: the server validates input with zod (apps/server/src/schemas.ts).
 */

// ---------- identity ----------
export type Role = 'admin' | 'member';
/** Delegated roles (integration-admin, blueprint-owner, approver), granted on top of `member` (any other slug is a custom role usable in permission subjects). */
export type UserProvider = 'local' | 'entra' | 'oidc' | 'github' | 'saml' | 'scim' | 'keycloak' | 'service';

export interface TeamRef {
  identifier: string;
  title: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  provider: UserProvider;
  role: Role;
  /** Additional (delegated or custom) roles. */
  roles: string[];
  teams: TeamRef[];
  active: boolean;
  lastLoginAt?: string | null;
  /** Onboarding tour completed or skipped; null: show it at next sign-in. */
  tourCompletedAt?: string | null;
  /** Runs the platform: manages every organization. */
  superadmin?: boolean;
  /** Organization the request ran in (role and teams are the ones of this organization). */
  organization?: OrgRef | null;
  /** Organizations the user belongs to. */
  organizations?: OrgMembership[];
}

// ---------- organizations (tenants) ----------

export interface OrgRef {
  id: string;
  slug: string;
  name: string;
}

export interface OrgMembership extends OrgRef {
  role: Role;
}

/** Where an organization's configuration as code comes from. */
export type ConfigSource =
  | { type: 'none' }
  /** CONFIG_DIR/orgs/<slug>/ (ConfigMap, git-sync sidecar…) */
  | { type: 'directory' }
  /** A Git repository the workers pull (https only; token as a secret reference of the organization). */
  | { type: 'git'; url: string; branch: string; path: string; token: string | null };

export interface ConfigSyncStatus {
  at: string | null;
  ok: boolean;
  revision: string | null;
  files: number;
  error: string | null;
}

export interface DomainStatus {
  domain: string;
  /** Verified domains route SSO sign-ins and let SSO-verified people join automatically. */
  verified: boolean;
  /** DNS TXT record to publish to verify the domain. */
  record: string;
  value: string;
}

export interface Organization extends OrgRef {
  domains: string[];
  domainStatus: DomainStatus[];
  managed: boolean;
  createdAt: string;
  memberCount: number;
  configSource: ConfigSource;
  configStatus: ConfigSyncStatus | null;
  /** Keycloak Organization linked to this organization (SSO). */
  sso: { enabled: boolean; keycloakOrgId: string | null };
}

export interface Member {
  id: string;
  email: string;
  name: string;
  provider: UserProvider;
  role: Role;
  via: 'manual' | 'sso' | 'config';
  active: boolean;
  lastLoginAt: string | null;
  joinedAt: string;
}

/** An identity provider connected to an organization (Keycloak brokering). */
export interface SsoProvider {
  alias: string;
  displayName: string;
  type: 'oidc' | 'saml';
  enabled: boolean;
  /** Email domain routed to this provider at sign-in. */
  domain: string | null;
  /** oidc: discovery / issuer URL · saml: metadata URL */
  url: string | null;
}

export interface SsoProviderInput {
  alias: string;
  displayName: string;
  type: 'oidc' | 'saml';
  /** oidc: issuer or .well-known/openid-configuration URL · saml: IdP metadata URL */
  url: string;
  clientId?: string;
  clientSecret?: string;
  domain?: string | null;
}

export interface Team {
  identifier: string;
  title: string;
  description: string;
  /** Members of this identity-provider group (Entra group id, OIDC group claim value, GitHub `org/team`) are members of the team (synchronised at sign-in). */
  entraGroupId: string | null;
  managed: boolean;
  members: { id: string; name: string; email: string }[];
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  userId: string;
  userName: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** Null: all rights of the owning user. */
  scopes?: string[] | null;
  blueprints?: string[] | null;
  ipAllow?: string[] | null;
}

// ---------- catalog ----------
/** A JSON Schema subset, extended with UI formats. */
export interface PropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  title?: string;
  description?: string;
  /** url · docs (URL of a markdown file, shown as the entity's Docs tab) · email · date · date-time · markdown · yaml · team · user · entity (with `blueprint`) */
  format?: string;
  /** For format `entity`: the blueprint the value points to. */
  blueprint?: string;
  enum?: (string | number)[];
  enumColors?: Record<string, string>;
  default?: unknown;
  items?: PropertySchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Hidden from tables; still visible on the entity page. */
  hidden?: boolean;
  [k: string]: unknown;
}

export interface ObjectSchema {
  properties: Record<string, PropertySchema>;
  required?: string[];
  /** Display order (defaults to declaration order). */
  order?: string[];
}

export interface BlueprintRelation {
  title?: string;
  target: string;
  many?: boolean;
  required?: boolean;
  /** Deleting the target: restrict (refuse), cascade (delete the referrers), detach (drop the reference), ignore (default). */
  onDelete?: 'restrict' | 'cascade' | 'detach' | 'ignore';
  /** Name of the reverse relation shown on the target's page. */
  inverseTitle?: string;
  /** UI/API writes must point to existing entities. */
  requireExisting?: boolean;
}

/** Derived property: `calculated` on read, `mirror` / `aggregation` materialised on write (filterable). */
export type ComputedProperty =
  | { kind: 'calculated'; title?: string; expression: string }
  | { kind: 'mirror'; title?: string; relation: string; property: string }
  | { kind: 'aggregation'; title?: string; blueprint: string; relation: string; function: 'count' | 'sum' | 'min' | 'max'; property?: string; filter?: string };

export interface Blueprint {
  identifier: string;
  title: string;
  description: string;
  icon: string | null;
  schema: ObjectSchema;
  relations: Record<string, BlueprintRelation>;
  computed?: Record<string, ComputedProperty>;
  /** Who may read / write / delete entities and run actions on them. Unset: read and run by everyone, write by the owner team. */
  permissions?: BlueprintPermissions;
  /** Date / date-time property after which `entity.expired` is emitted (ephemeral entities). */
  ttlProperty?: string | null;
  managed: boolean;
  entityCount?: number;
  createdAt: string;
  updatedAt: string;
}

export type RelationValue = string | string[] | null;

export interface Entity {
  blueprint: string;
  identifier: string;
  title: string;
  team: string | null;
  properties: Record<string, unknown>;
  relations: Record<string, RelationValue>;
  /** Computed, mirror and aggregation values of the blueprint's `computed` properties. */
  computed?: Record<string, unknown>;
  /** Who writes this entity: an integration identifier, `api`, `ui` or `config`. */
  source: string;
  /** Incremented on every write; served as the ETag and checked against If-Match. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EntityVersionDiff {
  /** `title`, `team`, `properties.<name>` or `relations.<name>`. */
  path: string;
  before: unknown;
  after: unknown;
}

export interface EntityVersion {
  version: number;
  op: 'create' | 'update' | 'delete' | 'revert' | 'restore';
  actor: string | null;
  source: string;
  /** The complete entity state after the change (before it, for a delete). */
  snapshot: { title: string; team: string | null; properties: Record<string, unknown>; relations: Record<string, RelationValue> };
  diff: EntityVersionDiff[];
  at: string;
}

export interface EntityPage {
  items: Entity[];
  /** Omitted when the client opted out of counting (`count=false`) or paged by cursor without asking for it. */
  total?: number;
  /** Opaque cursor for the next page (keyset pagination); absent on the last page. */
  nextCursor?: string;
}

export type FilterOp = 'eq' | 'neq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'exists';

export interface PropertyFilter {
  property: string;
  op: FilterOp;
  /** eq/neq/contains/gt/gte/lt/lte: scalar; in/between: array; exists: boolean (default true). */
  value?: string | number | boolean | Array<string | number | boolean>;
}

export interface RelationFilter {
  relation: string;
  /** Entities whose relation points at one of these identifiers. */
  target: string | string[];
}

/** Body of POST /entities/query and the parsed form of the `filter.*` / `relation.*` query parameters. */
export interface EntityQueryBody {
  blueprint?: string;
  search?: string;
  team?: string;
  source?: string;
  filters?: PropertyFilter[];
  relations?: RelationFilter[];
  /** title | updated | identifier | relevance | prop:<name> */
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  cursor?: string;
  count?: boolean;
}

export interface GraphNode {
  blueprint: string;
  identifier: string;
  title: string;
  team: string | null;
  /** Hops from the root entity. */
  depth: number;
  /** Referenced but not ingested (yet). */
  missing: boolean;
}
export interface GraphEdge {
  from: { blueprint: string; identifier: string };
  relation: string;
  to: { blueprint: string; identifier: string };
}
/** Multi-hop neighbourhood of an entity. Edges always point from the owner of the relation to its target. */
export interface EntityGraph {
  root: { blueprint: string; identifier: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The node or edge cap was hit: the graph is partial (nearest nodes first). */
  truncated: boolean;
}

export interface RelatedEntities {
  /** Entities this entity points to, by relation name. */
  outgoing: Record<string, Entity[]>;
  /** Entities pointing to this one: `<blueprint>.<relation>` → entities. */
  incoming: Record<string, Entity[]>;
  /** Display names of the `incoming` groups (the relation's `inverseTitle`). */
  incomingTitles?: Record<string, string>;
}

// ---------- self-service ----------
export type ActionTrigger = 'create' | 'day-2' | 'delete';

/** Who: roles, teams, users (emails), and/or the team owning the target entity. Empty = everyone. */
export interface Subjects {
  roles?: string[];
  teams?: string[];
  users?: string[];
  ownerTeam?: boolean;
}

export interface BlueprintPermissions {
  read?: Subjects;
  write?: Subjects;
  delete?: Subjects;
  run?: Subjects;
}

/** Effective access of the caller on one blueprint: `team` means only entities of the caller's teams. */
export type Access = boolean | 'team';
export interface EffectivePermissions {
  roles: string[];
  admin: boolean;
  blueprints: Record<string, { read: Access; write: Access; delete: Access; run: Access }>;
}

/** What an approval nobody decided becomes once it expires (default: fail). */
export type ApprovalExpiry = 'fail' | 'reject' | 'approve' | 'skip';

/** Reminders, escalation and expiry of an approval (step or pre-start policy). Delays: `30m`, `4h`, `1d`. */
export interface ApprovalTimers {
  /** Re-notify the approvers who have not decided yet, every … */
  remindEvery?: string;
  /** At most this many reminders (default 3). */
  maxReminders?: number;
  /** After `after` without a decision, these approvers become eligible too and are notified. */
  escalate?: { after: string; approvers: Subjects };
  onExpiry?: ApprovalExpiry;
}

export interface ApprovalPolicy extends ApprovalTimers {
  required: boolean;
  approvers?: Subjects;
  minApprovals?: number;
  allowSelfApproval?: boolean;
  /** The request expires after this delay (then `onExpiry`, default fail). */
  expireAfter?: string;
}

/** A sequential approval tier: opens once the previous one reached its minimum. */
export interface ApprovalTier {
  name: string;
  approvers?: Subjects;
  minApprovals?: number;
}

/** Progress of an approval (run page): tiers, escalation, reminders. */
export interface ApprovalProgress {
  tiers?: { name: string; minApprovals: number; approved: number; state: 'done' | 'open' | 'waiting' }[];
  escalatedAt?: string | null;
  escalateAt?: string | null;
  reminders?: number;
  nextReminderAt?: string | null;
  expiresAt?: string | null;
}

/** Out-of-office delegation: the delegate decides for the user, optionally within a date range. */
export interface Delegation {
  user: { id: string; name: string; email: string };
  delegate: { id: string; name: string; email: string };
  startsAt: string | null;
  endsAt: string | null;
  /** In effect now (inside its date range). */
  active: boolean;
  createdAt: string;
}

export interface InvokerConfig {
  type: string;
  [k: string]: unknown;
}

// ---------- workflows ----------
export type WorkflowStepType = 'invoke' | 'approval' | 'agent' | 'transform' | 'wait' | 'input' | 'workflow' | 'switch' | 'fragment';

interface WorkflowStepBase {
  /** Letters, digits and _; later steps read `{{ steps.<id>.output }}`. */
  id: string;
  name?: string;
  /** JSONata condition evaluated against the run context; falsy → step skipped. */
  if?: string;
  /** Steps this one waits for. Omitted: the previous step. Empty: starts with the workflow (parallel). */
  needs?: string[];
  retries?: number;
  retryDelaySeconds?: number;
  timeoutMinutes?: number;
  /** A failure does not fail the workflow; dependents still run. */
  continueOnError?: boolean;
  /** The step output must match this schema (and stay under the platform size cap) or the step fails. */
  outputSchema?: ObjectSchema;
  /** Service level: not finished this many minutes after it started → `step.sla_breached` (once) and a notification. */
  slaMinutes?: number;
  /** success (default): after its dependencies succeeded · failure: only if one of them failed (fallback) · always: once they are done (cleanup). */
  when?: 'success' | 'failure' | 'always';
  /** fail (default) · skip: a timeout skips the step · continue: a timeout fails it without failing the workflow. */
  onTimeout?: 'fail' | 'skip' | 'continue';
  /** Branch of a switch step: `<switchStepId>.<caseId>` (or several); skipped when another branch was taken. */
  case?: string | string[];
}

/** Inline loop (invoke, agent, transform): `item` and `index` in templates; output `{ results: [{ item, status, output }], succeeded, failed }`. */
export interface InlineForEach {
  items: string;
  /** Agent steps only: items processed in parallel (invoke and transform steps iterate one at a time). */
  maxConcurrency?: number;
  failFast?: boolean;
}

export interface InvokeStep extends WorkflowStepBase {
  type: 'invoke';
  invoker: InvokerConfig;
  forEach?: InlineForEach;
}

export interface ApprovalStep extends WorkflowStepBase, ApprovalTimers {
  type: 'approval';
  /** Instead of approvers / minApprovals: tiers decided in order; a reject at any tier rejects. */
  tiers?: ApprovalTier[];
  approvers?: Subjects;
  minApprovals?: number;
  allowSelfApproval?: boolean;
  /** Decisions beyond yes / no: the approver picks one (`output.choice`). */
  choices?: string[];
  /** Fields the approver fills along with an approval (`output.values`). */
  fields?: ObjectSchema;
  /** Markdown template shown to approvers (e.g. an AI summary from an earlier step). */
  message?: string;
}

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AgentTool = 'catalog' | 'upsert_entity' | 'trigger_action' | 'http';
export type AiProvider = 'anthropic' | 'bedrock' | 'vertex';

export interface AgentGuardrails {
  entityBlueprints?: string[];
  actions?: string[];
  httpHosts?: string[];
  httpMethods?: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[];
  maxWrites?: number;
}

export interface AgentMcpServer {
  name: string;
  url: string;
  /** `${secret:NAME}` */
  token?: string;
  allowedTools?: string[];
}

export interface AgentStep extends WorkflowStepBase {
  type: 'agent';
  model?: string;
  effort?: AgentEffort;
  system?: string;
  prompt: string;
  /** Structured output: the step output follows this schema. Without it the output is `{ text }`. */
  output?: ObjectSchema;
  /** catalog: read-only lookups · the others are governed write tools and need `guardrails`. */
  tools?: AgentTool[];
  guardrails?: AgentGuardrails;
  /** Remote MCP servers the model may use. */
  mcpServers?: AgentMcpServer[];
  maxTurns?: number;
  maxTokens?: number;
  /** Stop the run's AI calls at this total spend (dollars). */
  maxCostUsd?: number;
  provider?: AiProvider;
  /** `${secret:NAME}` reference; default: the platform's ANTHROPIC_API_KEY. */
  apiKey?: string;
  forEach?: InlineForEach;
}

export interface TransformStep extends WorkflowStepBase {
  type: 'transform';
  /** Output key → JSONata expression. */
  output: Record<string, string>;
  forEach?: InlineForEach;
}

/** Branching: the first case whose JSONata `when` is truthy is taken (output `{ case }`); steps with `case: <id>.<case>` of other branches are skipped. */
export interface SwitchStep extends WorkflowStepBase {
  type: 'switch';
  cases: { id: string; when: string }[];
  /** Case taken when none matches (omitted: no branch). */
  default?: string;
}

/** Pause: a duration (`15m`), until a time (template), or until an external event is posted to the step. */
export interface WaitStep extends WorkflowStepBase {
  type: 'wait';
  duration?: string;
  until?: string;
  event?: { name: string; filter?: string };
}

/** Ask the requester or an operator for data mid-run. */
export interface InputStep extends WorkflowStepBase {
  type: 'input';
  message?: string;
  inputs: ObjectSchema;
  assignees?: Subjects;
  remindEvery?: string;
  maxReminders?: number;
}

/** Run another action as a child workflow (optionally once per item of a list) and wait for the result. */
export interface WorkflowCallStep extends WorkflowStepBase {
  type: 'workflow';
  action: string;
  inputs?: Record<string, unknown>;
  entity?: string;
  forEach?: { items: string; maxConcurrency?: number; failFast?: boolean };
}

/** Include a reusable fragment: its steps are inlined (ids `<id>__<inner id>`) when a run starts. Only id, name, if and needs apply. */
export interface FragmentStep extends WorkflowStepBase {
  type: 'fragment';
  fragment: string;
  /** Parameter values: literals or `{{ }}` templates over the caller's context (read as `params.<name>` inside). */
  with?: Record<string, unknown>;
}

export type WorkflowStep = InvokeStep | ApprovalStep | AgentStep | TransformStep | WaitStep | InputStep | WorkflowCallStep | SwitchStep | FragmentStep;

export type StepStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'WAITING_APPROVAL' | 'WAITING' | 'SUCCESS' | 'FAILURE' | 'SKIPPED' | 'CANCELLED';

export interface RunStep {
  id: string;
  name: string;
  type: WorkflowStepType;
  needs: string[];
  /** Inlined from a fragment: the id of the workflow's fragment step it belongs to. */
  fragment?: string;
  status: StepStatus;
  statusLabel: string | null;
  attempt: number;
  maxAttempts: number;
  /** continueOnError, or a timeout with `onTimeout: continue`: the failure does not fail the workflow. */
  continueOnError: boolean;
  when?: 'success' | 'failure' | 'always';
  case?: string[];
  /** A failure handled by a `when: failure` step that succeeded (the workflow does not fail because of it). */
  handled?: boolean;
  output: unknown;
  link: string | null;
  /** Approval and input steps: the rendered message for the people asked. */
  message: string | null;
  /** Input steps (and approvals with fields): the form to fill, and who may. */
  form?: ObjectSchema | null;
  choices?: string[] | null;
  canSubmit?: boolean;
  /** Sub-workflow steps: the child runs. */
  children?: { runId: string; status: string; item?: unknown }[];
  /** AI spend of the step in dollars (null: none recorded). */
  costUsd?: number | null;
  approvals: RunApproval[];
  /** Approval and input steps: tiers, escalation and reminders. */
  approval?: ApprovalProgress | null;
  canApprove?: boolean;
  /** A failed step the caller may retry. */
  canRetry?: boolean;
  /** When the step passed its `slaMinutes` without finishing (null: no breach). */
  slaBreachedAt?: string | null;
  /** Admins: force the step to SKIPPED / SUCCESS (with a comment). */
  canSkip?: boolean;
  canComplete?: boolean;
  startedAt: string | null;
  endedAt: string | null;
}

/** A file attached to a run step (reports, plans, logs…). Downloaded from `GET /runs/:id/artifacts/:artifactId`. */
export interface RunArtifact {
  id: string;
  stepId: string | null;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: string;
  createdBy: string | null;
}

/** A workflow test (`tests` of an action): run with mocks, nothing external is called. */
export interface WorkflowTest {
  name: string;
  inputs?: Record<string, unknown>;
  entity?: string | null;
  mocks?: Record<string, { status?: 'SUCCESS' | 'FAILURE'; output?: unknown }>;
  expect?: {
    status?: 'SUCCESS' | 'FAILURE';
    steps?: Record<string, { status?: 'SUCCESS' | 'FAILURE' | 'SKIPPED'; output?: unknown }>;
    /** Partial match against the run result (outputs by step id). */
    outputs?: Record<string, unknown>;
  };
}

export interface WorkflowTestResult {
  name: string;
  passed: boolean;
  /** Simulated run status. */
  status: 'SUCCESS' | 'FAILURE';
  steps: { id: string; status: 'SUCCESS' | 'FAILURE' | 'SKIPPED'; output: unknown; error?: string }[];
  outputs: Record<string, unknown>;
  /** What did not match: dotted path, expected and actual values. */
  diffs: { path: string; expected: unknown; actual: unknown }[];
  /** Problems that fail the test regardless of expectations (unmocked external steps, input errors, template errors). */
  errors: string[];
}

export interface WorkflowTestReport {
  passed: number;
  failed: number;
  results: WorkflowTestResult[];
}

/** A user submits a form: from the self-service page (`on: create`) or on an entity (`day-2`, `delete`). */
export interface FormTrigger {
  type: 'form';
  on: ActionTrigger;
  /** The kind of entity it creates or acts on; null: a general workflow. */
  blueprint: string | null;
  /** The form fields. */
  inputs: ObjectSchema;
  /** Who may submit it (empty: everyone). */
  allowed: Subjects;
  /** Approval before the workflow starts. */
  approval: ApprovalPolicy;
}

/** Like a form, without a page: inputs only come from the API. */
export interface ApiTrigger extends Omit<FormTrigger, 'type'> {
  type: 'api';
}

/** Cron schedule: one run per tick. `inputs` are `{{ }}` templates over `schedule.at`. */
export interface ScheduleTrigger {
  type: 'schedule';
  cron: string;
  timezone: string;
  inputs: Record<string, unknown>;
  /** Missed ticks: none (default) · last (one run for the latest) · all (up to `maxCatchUp`, last 7 days). */
  catchUp?: 'none' | 'last' | 'all';
  maxCatchUp?: number;
  /** Fan-out: one run per matching entity on each tick (`entity` in the input templates). */
  entities?: { blueprint: string; filter?: string; limit?: number };
  /** Next planned tick (read-only). */
  nextRunAt?: string | null;
}

/** Recurring (`cron` + `duration`) or fixed (`from`/`to`) window when the workflow does not start. */
export interface BlackoutWindow {
  name?: string;
  cron?: string;
  duration?: string;
  from?: string;
  to?: string;
  timezone: string;
}

export interface BlackoutSpan {
  name: string;
  from: string;
  until: string;
}

export interface EventTrigger {
  type: 'event';
  event: 'entity.created' | 'entity.updated' | 'entity.deleted' | 'entity.expired' | 'scorecard.changed' | 'run.finished';
  blueprint?: string | null;
  /** run.finished: only runs of this action. */
  action?: string | null;
  /** JSONata over `{ event }`; truthy fires the workflow. */
  filter?: string;
  entity?: string;
  inputs: Record<string, unknown>;
}

/** `POST /api/v1/hooks/<action>` with the secret (token or HMAC signature). `inputs` are templates over `body` and `headers`. */
export interface WebhookTrigger {
  type: 'webhook';
  secret: string;
  signatureHeader?: string;
  blueprint?: string | null;
  entity?: string;
  inputs: Record<string, unknown>;
}

/** What starts a workflow. */
export type WorkflowTrigger = FormTrigger | ApiTrigger | ScheduleTrigger | EventTrigger | WebhookTrigger;
/** Triggers started by a person through a form payload (the form page, or the API). */
export type FormLikeTrigger = FormTrigger | ApiTrigger;

/** A workflow: a trigger and steps. Without a trigger, or without steps, it is a draft and cannot run. */
export interface Action {
  identifier: string;
  title: string;
  description: string;
  icon: string | null;
  trigger: WorkflowTrigger | null;
  /** Increments on every change of the definition (see the history). */
  version: number;
  /** Secrets the workflow may reference (`NAME`, `env:NAME`). Omitted: any. */
  secrets?: string[];
  /** Non-admins only see each step's id, name and type (no configuration). */
  steps: WorkflowStep[];
  /** Legacy single-invoker form (configuration files), when the action was declared with `invoker`. */
  invoker?: InvokerConfig;
  /** Templates evaluated when a run starts: `vars.<name>` in every template and condition. */
  vars?: Record<string, unknown>;
  /** Templates evaluated when the run ends: the run result (seen by parent workflows). Default: the outputs by step id. */
  outputs?: Record<string, unknown>;
  enabled: boolean;
  managed: boolean;
  /** Automated starts are skipped (or deferred) and form/API submissions refused during these windows. */
  blackouts?: BlackoutWindow[];
  blackoutMode?: 'skip' | 'defer';
  /** Read-only: the blackout in effect now and the next one. */
  blackout?: { active: BlackoutSpan | null; next: BlackoutSpan | null };
  /** Service level of a whole run (minutes from the request): `run.sla_breached` once when exceeded. */
  slaMinutes?: number;
  /** Workflow tests (admins only). */
  tests?: WorkflowTest[];
  /** At most `max` runs of a group at a time (group: template, default the action id). */
  concurrency?: RunConcurrency;
  /** Claim order of queued runs, -100..100 (higher first, default 0). */
  priority?: number;
}

export interface RunConcurrency {
  group?: string;
  max: number;
  /** queue: wait for a slot · cancel-in-progress: cancel the older runs of the group · reject: 409 when full. */
  mode: 'queue' | 'cancel-in-progress' | 'reject';
}

/** Body of a 412 answer to a write whose If-Match version is stale (`{ error, conflict }`). */
export interface EditConflict {
  /** The stored version (null: the resource no longer exists). */
  currentVersion: number | null;
  /** Who made the current version (null when unknown). */
  changedBy: { email: string | null; name: string | null } | null;
  changedAt: string | null;
}

export interface ActionVersion {
  version: number;
  actor: string | null;
  note: string | null;
  at: string;
}

export interface ActionVersionDiff {
  /** Dotted paths outside the steps that differ. */
  fields: { path: string; before: unknown; after: unknown }[];
  stepsAdded: string[];
  stepsRemoved: string[];
  stepsChanged: { id: string; changes: { path: string; before: unknown; after: unknown }[] }[];
  stepsReordered: boolean;
}

export interface DryRunStep {
  id: string;
  type: WorkflowStepType;
  /** planned: would run · skipped: its condition is false · error: could not be rendered or validated */
  status: 'planned' | 'skipped' | 'error';
  condition?: boolean;
  /** The step as it would be executed (templates rendered, secrets masked). */
  rendered?: unknown;
  /** Simulated output, as seen by later steps. */
  output?: unknown;
  errors: string[];
}

export interface DryRunResult {
  valid: boolean;
  inputErrors: string[];
  /** Secret and environment references that do not resolve. */
  missingSecrets: string[];
  steps: DryRunStep[];
  /** The action's `vars`, evaluated. */
  vars?: Record<string, unknown>;
  /** The action's `outputs` against the simulated steps (the run result). */
  outputs?: Record<string, unknown>;
}

export type RunStatus = 'PENDING_APPROVAL' | 'QUEUED' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILURE' | 'REJECTED' | 'CANCELLED';

export interface RunLog {
  /** Sequence number (monotonic per run): pass the last one as `?after=` to fetch only newer lines. */
  seq?: number;
  at: string;
  /** Step that wrote the line (null: the workflow itself). */
  stepId?: string | null;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface RunApproval {
  userId: string;
  userName: string;
  decision: 'approved' | 'rejected';
  comment: string;
  at: string;
  /** Decided by a delegate for this person. */
  onBehalfOf?: { id: string; name: string } | null;
  /** Tiered approval steps: the tier (0-based) the decision belongs to. */
  tier?: number | null;
}

export interface Run {
  id: string;
  action: string;
  actionTitle: string;
  blueprint: string | null;
  entity: string | null;
  inputs: Record<string, unknown>;
  status: RunStatus;
  statusLabel: string | null;
  link: string | null;
  triggeredBy: { id: string; name: string; email: string };
  approvals: RunApproval[];
  /** Pre-start approval: escalation, reminders, expiry. */
  approval?: ApprovalProgress | null;
  result: unknown;
  /** Set on child runs of a sub-workflow step. */
  parent?: { runId: string; stepId: string } | null;
  /** The version of the action's definition this run started from. */
  actionVersion?: number | null;
  /** What started the run: form, api, schedule, event, webhook, workflow (parent run) or rerun. */
  trigger?: { type: string; [k: string]: unknown };
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Present on GET /runs/:id. */
  logs?: RunLog[];
  /** GET /runs/:id returns the newest lines only (see GET /runs/:id/logs to page through the rest). */
  logsTruncated?: boolean;
  /** Total AI spend of the run in dollars (null: none). */
  costUsd?: number | null;
  steps?: RunStep[];
  /** Approvals page: the step waiting for the caller's decision (null: the run-level approval). */
  pendingStep?: { id: string; name: string; message: string | null; kind?: 'approval' | 'input' } | null;
  /** Approvals page: the caller decides as the delegate of this person. */
  onBehalfOf?: { id: string; name: string } | null;
  /** GET /runs/waiting: who the requester's run waits on (the open decision's approvers or the input step's assignees). */
  waitingOn?: WaitingOn | null;
  canApprove?: boolean;
  canCancel?: boolean;
  /** Requester or admin, finished run. */
  canRerun?: boolean;
  /** Requester or admin, failed or cancelled run with steps to start over. */
  canResume?: boolean;
  /** When the run passed the action's `slaMinutes` without finishing (null: no breach). */
  slaBreachedAt?: string | null;
  /** Present on GET /runs/:id: files attached to its steps. */
  artifacts?: RunArtifact[];
  /** Claim order (higher first). */
  priority?: number;
  /** Concurrency group of the run; `ahead`: runs holding or waiting for a slot before it (queued runs). */
  concurrency?: { group: string; max: number; ahead?: number } | null;
  /** Set while the run is paused: no new step starts. */
  paused?: { at: string; by: string | null } | null;
  /** Requester or admin, run in progress. */
  canPause?: boolean;
  canUnpause?: boolean;
}

export interface RunPage {
  items: Run[];
  /** Omitted with `count=false` and on cursor pages. */
  total?: number;
  nextCursor?: string;
}

// ---------- integrations ----------
export interface EntityMapping {
  blueprint: string;
  identifier: string;
  title?: string;
  team?: string;
  properties?: Record<string, string>;
  relations?: Record<string, string>;
}

export interface Mapping {
  /** Source kind (e.g. `repository`, `apps/v1/Deployment`); ignored by webhook integrations. */
  kind: string;
  /** JSONata, keep items where it is truthy. */
  filter?: string;
  /** JSONata producing an array from each item (fan-out). */
  items?: string;
  /** JSONata, `true` deletes the mapped entity (webhook integrations). */
  delete?: string;
  /** Merge mapped properties into existing ones instead of replacing them. */
  merge?: boolean;
  entity: EntityMapping;
}

export interface SyncStats {
  upserted: number;
  deleted: number;
  skipped: number;
  failed: number;
}

export interface SyncItemError {
  /** Mapping kind the item came from. */
  mapping: string;
  /** blueprint/identifier of the entity, or a short key of the raw item. */
  key: string;
  message: string;
}

export interface SyncRun {
  id: string;
  integration: string;
  trigger: 'schedule' | 'manual' | 'webhook' | 'startup';
  status: 'running' | 'success' | 'partial' | 'failure';
  stats: SyncStats;
  logs: string[];
  /** Structured per-item errors (capped). */
  errors: SyncItemError[];
  startedAt: string;
  endedAt: string | null;
}

export interface Integration {
  identifier: string;
  title: string;
  type: string;
  enabled: boolean;
  /** Admin-only; secrets are `${secret:NAME}` / `${env:NAME}` references, never values. */
  config: Record<string, unknown>;
  mappings: Mapping[];
  intervalMinutes: number;
  deleteMissing: boolean;
  /** Ownership priority when integrations write the same entity (higher wins). */
  priority: number;
  /** Blueprints this integration is the primary source of. */
  primaryFor: string[];
  /** Cron expression (UTC) replacing intervalMinutes. */
  schedule?: string;
  deleteMaxPercent: number;
  deleteDryRun: boolean;
  managed: boolean;
  lastSync: SyncRun | null;
  /** End time of the last fully successful sync (for alerting). */
  lastSuccessAt: string | null;
  /** Webhook integrations: where third parties POST events. */
  webhookUrl?: string;
}

// ---------- outbound webhooks ----------
export interface Webhook {
  identifier: string;
  title: string;
  url: string;
  /** entity.* · run.created/updated · approval.requested/decided · sync.finished/failed, or `*` / `entity.*` */
  events: string[];
  blueprints: string[];
  /** Extra request headers; values are usually `${secret:NAME}` references. */
  headers: Record<string, string>;
  filter?: string | null;
  transform?: string | null;
  enabled: boolean;
  managed: boolean;
  hasSecret: boolean;
  hasSecondarySecret?: boolean;
}

export interface Delivery {
  id: string;
  webhook: string;
  event: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

// ---------- admin ----------
/** An external secret manager available on this deployment. */
export interface SecretProviderInfo {
  kind: string;
  title: string;
  enabled: boolean;
  example: string;
}

export interface SecretInfo {
  name: string;
  description: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  actorEmail: string | null;
  target: string | null;
  detail: Record<string, unknown>;
}

/**
 * A configuration field of a plugin, rendered by the UI builders. Values may contain `{{ }}` templates and
 * `${secret:NAME}` references.
 *  text · textarea · number · boolean · select (options) · secret (a ${secret:…} reference) · list (array of strings)
 *  keyvalue (object of strings) · json (any JSON value) · blueprint (a blueprint identifier)
 */
export interface PluginField {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'secret' | 'list' | 'keyvalue' | 'json' | 'blueprint';
  required?: boolean;
  options?: string[];
  placeholder?: string;
  help?: string;
  /** Shown under "Advanced". */
  advanced?: boolean;
}

export interface PluginInfo {
  type: string;
  title: string;
  description: string;
  /** Integrations: kinds the source can list. */
  kinds?: string[];
  /** Example configuration, shown in the editor. */
  example: Record<string, unknown>;
  /** Form of the configuration for the UI builder; without it the UI falls back to a JSON editor. */
  fields?: PluginField[];
}

export interface NotificationSettings {
  slack: { botToken?: string; webhookUrl?: string; defaultChannel?: string };
  teams: { webhookUrl?: string };
  email: { smtpUrl?: string; from?: string };
}

export interface NotificationPrefs {
  /** Approvals (and inputs) waiting for me. */
  approvals: ('email' | 'slack')[];
  /** The outcome of runs I requested. */
  runs: ('email' | 'slack')[];
}

export interface ModelInfo {
  value: string;
  label: string;
  description: string;
  /** $ per million tokens. */
  inputPrice: number;
  outputPrice: number;
}

export interface Meta {
  /** Who may create organizations. */
  orgCreation: 'everyone' | 'superadmin';
  /** Keycloak sign-in: the URL of its account console (password, MFA, linked identities). */
  accountUrl: string | null;
  /** Product name (BRAND_NAME). */
  name: string;
  /** Custom logo URL / data URI (BRAND_LOGO); null: the built-in logo. */
  logo: string | null;
  version: string;
  authProviders: ('local' | 'entra' | 'oidc' | 'github' | 'saml' | 'keycloak')[];
  /** Labels of the generic OIDC / SAML sign-in buttons. */
  oidcTitle?: string;
  /** Browser sessions use an httpOnly cookie and a CSRF header. */
  sessionCookie?: boolean;
  samlTitle?: string;
  allowRegistration: boolean;
  invokers: PluginInfo[];
  sources: PluginInfo[];
  /** Models offered to agent steps. */
  models: ModelInfo[];
}

// ---------- AI ----------
export interface AiStatus {
  enabled: boolean;
  provider: AiProvider;
  assistantModel: string;
}

export interface AiUsageReport {
  since: string;
  totals: { calls: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; failed: number };
  byModel: { model: string; calls: number; costUsd: number }[];
  byAction: { key: string | null; calls: number; costUsd: number }[];
  byTeam: { key: string | null; calls: number; costUsd: number }[];
  byDay: { day: string; costUsd: number }[];
}

export interface AiBudget {
  id: string;
  scope: 'global' | 'action' | 'team' | 'run';
  key: string;
  softUsd: number | null;
  hardUsd: number | null;
}

export interface AiReview {
  id: string;
  at: string;
  trigger: 'schedule' | 'manual';
  status: 'success' | 'failure';
  findings: { kind: string; blueprint: string; identifier: string; detail: string }[];
  counts: Record<string, number>;
  summary: string;
  costUsd: number | null;
  error: string | null;
}

export interface AiPrice {
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  source: 'database' | 'config' | 'builtin';
}

export interface HomeSummary {
  blueprints: { identifier: string; title: string; icon: string | null; count: number }[];
  /** Decisions waiting for the caller (capped at 100: 100 means "100 or more"). */
  pendingApprovals: number;
  myRuns: Run[];
  recentEntities: Entity[];
  /** The caller's requests waiting on someone else's decision or input (newest first, at most 20). */
  waitingOnOthers: Run[];
  /** Recently changed entities owned by the caller's teams (empty without teams). */
  teamEntities: Entity[];
}

/** Who a run waits on: role names, team identifiers and user emails (an `ownerTeam` rule is resolved to the run's team). */
export interface WaitingOn {
  roles: string[];
  teams: string[];
  users: string[];
}

// ---------- scorecards ----------
export interface ScorecardLevel {
  name: string;
  color?: string;
}

export interface ScorecardRule {
  identifier: string;
  title: string;
  description?: string;
  /** Name of the level the rule belongs to. */
  level: string;
  /** JSONata over the entity; passes when truthy. */
  expression: string;
}

export interface Scorecard {
  identifier: string;
  title: string;
  description: string;
  blueprint: string;
  /** Lowest to highest. */
  levels: ScorecardLevel[];
  rules: ScorecardRule[];
  managed: boolean;
}

export interface RuleResult {
  rule: string;
  title: string;
  level: string;
  passed: boolean;
  /** Evaluation error of the expression (counts as failed). */
  error?: string;
}

export interface ScorecardResult {
  scorecard: string;
  scorecardTitle: string;
  blueprint: string;
  entity: string;
  /** Highest level reached; null: not even the first one. */
  level: string | null;
  levelColor?: string | null;
  passed: number;
  total: number;
  rules: RuleResult[];
  evaluatedAt: string;
  /** Present on GET .../scorecards: levels of the scorecard, lowest first. */
  levels?: ScorecardLevel[];
}

export interface ScorecardSummary {
  scorecard: string;
  total: number;
  /** Number of entities per level name (`none`: below the first level). */
  distribution: Record<string, number>;
  /** Daily snapshots of the distribution. */
  trend: { day: string; distribution: Record<string, number> }[];
}

// ---------- fragments ----------
/** Reusable steps, included in workflows by `type: fragment` steps. */
export interface Fragment {
  identifier: string;
  title: string;
  description: string;
  /** Parameters callers pass with `with`. */
  params: ObjectSchema;
  steps: WorkflowStep[];
  /** Output name → JSONata over the fragment's steps (`steps.<inner id>.output…`). */
  outputs: Record<string, string>;
  version: number;
  managed: boolean;
  updatedAt: string;
}

export interface FragmentVersion {
  version: number;
  actor: string | null;
  at: string;
  definition: Record<string, unknown>;
}

// ---------- connectors and connections ----------
// Server: apps/server/src/integrations/connectors/, schemas `connectorDef` / `connectionDef` in schemas.ts.
// Templates: `{{ connection.<field> }}`, `{{ inputs.<name> }}` (operations), `{{ output.<name> }}` (poll requests).

export type AuthType =
  | 'basic'
  | 'bearer'
  | 'header'
  | 'oauth2-client-credentials'
  | 'github-app'
  | 'azure-managed-identity'
  | 'azure-workload-identity'
  | 'gcp-service-account'
  | 'aws-sigv4'
  | 'mtls';

export type ConnectorCategory =
  | 'source-control'
  | 'ci-cd'
  | 'cloud'
  | 'incident'
  | 'observability'
  | 'itsm'
  | 'project-management'
  | 'security'
  | 'artifacts'
  | 'identity'
  | 'internal'
  | 'other';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** An authentication method a definition supports. */
export interface ConnectorAuthMethod {
  type: AuthType;
  title?: string;
  description?: string;
  /** Auth block values fixed by the definition (the connection cannot change them); strings may use `{{ connection.x }}`. */
  set: Record<string, unknown>;
  /** `header`: header name → format with `{credential}` placeholders the connection supplies (`Token token={token}`). */
  headers?: Record<string, string>;
  /** Extra auth fields holding credentials (must be references in connections). */
  secrets?: string[];
}

/** Pagination of a listing (vocabulary of the `http` source). */
export interface ConnectorPagination {
  type: 'none' | 'link' | 'next' | 'offset' | 'page' | 'cursor';
  nextUrl?: string;
  param?: string;
  pageSize?: number;
  startAt?: number;
  totalPath?: string;
  cursorPath?: string;
  cursorHeader?: string;
  in?: 'query' | 'body';
}

/** One request of a definition (path relative to the connection's baseUrl). */
export interface ConnectorRequest {
  method: HttpMethod;
  /** Starts with `/`; each `{{ }}` value is one URL-encoded segment; empty segments collapse. */
  path: string;
  /** Values that render empty are left out. */
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

/** Ingestion: how to list one kind of item. */
export interface ConnectorKind extends ConnectorRequest {
  title?: string;
  description?: string;
  /** JSONata selecting the items (default: the response). */
  itemsPath?: string;
  pagination?: ConnectorPagination;
  /** Incremental syncs: query parameter receiving the start time of the previous successful sync. */
  since?: { param: string };
  /** Connection fields this kind needs. */
  requires?: string[];
}

export interface ConnectorPoll extends ConnectorRequest {
  intervalSeconds: number;
  timeoutMinutes: number;
  /** JSONata over { connection, inputs, output, status, body }: success when truthy. */
  done: string;
  /** Same context, checked first: failure when truthy. */
  failed?: string;
  /** Output fields merged over the operation's output when finished. */
  output?: Record<string, string>;
}

/** Actions: an API call usable by workflow steps. */
export interface ConnectorOperation extends ConnectorRequest {
  title: string;
  description: string;
  /** Kind of item it applies to (offered on the entities that kind is mapped to). */
  kind?: string;
  /** The operation's form (same schema as workflow forms). */
  inputs: ObjectSchema;
  /** Output fields: JSONata over { connection, inputs, status, body }. Default: the response body. */
  output?: Record<string, string>;
  poll?: ConnectorPoll;
  /** Changes nothing (allowed on read-only connections). Default: GET only. */
  readOnly?: boolean;
}

/** A connector definition: built-in (YAML shipped with the platform) or the organization's own. */
export interface ConnectorDefinition {
  identifier: string;
  title: string;
  description: string;
  icon?: string | null;
  category: ConnectorCategory;
  /** The connection form; always declares `baseUrl`. */
  fields: ObjectSchema;
  /** Supported auth methods (first: the default). */
  auth: ConnectorAuthMethod[];
  authOptional: boolean;
  /** Headers sent with every request. */
  headers: Record<string, string>;
  test?: ConnectorRequest & { expect: { status?: number[]; condition?: string } };
  kinds: Record<string, ConnectorKind>;
  operations: Record<string, ConnectorOperation>;
  example?: { fields?: Record<string, unknown>; auth?: Record<string, unknown>; mappings?: Mapping[] };
  /** Shipped with the platform: read-only, not versioned (version 0). */
  builtin: boolean;
  managed: boolean;
  version: number;
  updatedAt: string | null;
}

export interface ConnectorVersion {
  version: number;
  actor: string | null;
  at: string;
  definition: Record<string, unknown>;
}

/** A configured instance of a connector, per organization. Credentials are references (`${secret:NAME}`…), never values. */
export interface Connection {
  identifier: string;
  title: string;
  description: string;
  connector: string;
  fields: Record<string, unknown>;
  /** `{ type, …values }`; null when the definition needs none. */
  auth: ({ type: AuthType } & Record<string, unknown>) | null;
  /** read: ingestion and read-only operations; read-write: also operations that change things. */
  access: 'read' | 'read-write';
  /** Automation allow-list (workflow identifiers or run teams); empty: any. */
  allowed: { workflows?: string[]; teams?: string[] };
  /** Raw API calls: allowed methods and path prefixes. Absent: none. */
  api?: { methods: HttpMethod[]; paths: string[] };
  /** Optimistic concurrency: send it back as If-Match. */
  version: number;
  managed: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST /connections/:id/test */
export interface ConnectionTestResult {
  ok: boolean;
  /** HTTP status of the test request; null when no response (network, resolution or configuration error). */
  status: number | null;
  latencyMs: number | null;
  error?: string;
  checkedAt: string;
}

/** GET /connections/:id/usage: what references the connection (it cannot be deleted while used). */
export interface ConnectionUsage {
  integrations: string[];
  actions: string[];
  fragments: string[];
}

/** POST /connectors/:id/operations/:operation/render: the request an operation would send (no credentials). */
export interface RenderedConnectorRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** The inputs with defaults applied. */
  inputs: Record<string, unknown>;
}

// ---------- policies ----------
export interface Policy {
  identifier: string;
  title: string;
  description: string;
  enabled: boolean;
  /** `run`: before a run is queued; `entity`: before an entity is created, updated or deleted. */
  target: 'run' | 'entity';
  match: { actions?: string[]; blueprints?: string[]; operations?: ('create' | 'update' | 'delete')[] };
  /** JSONata over { inputs, entity, previous, principal, action, blueprint, operation }: true allows. */
  expression: string;
  /** Deny message (may embed {{ expression }}). */
  message: string;
  managed: boolean;
}

// ---------- blueprint change impact ----------
export type EntityMigration =
  { type: 'rename'; from: string; to: string } | { type: 'default'; property: string; value: unknown } | { type: 'remove'; property: string };

export interface InvalidEntity {
  identifier: string;
  title: string;
  errors: string[];
}

export interface ValidationReport {
  blueprint: string;
  status: 'running' | 'done';
  /** Entities checked. */
  total: number;
  invalid: number;
  /** A sample of the invalid entities. */
  samples: InvalidEntity[];
  startedAt: string;
  finishedAt: string | null;
}

/** A deleted entity that can still be restored. */
export interface Tombstone {
  blueprint: string;
  identifier: string;
  title: string;
  team: string | null;
  source: string;
  deletedBy: string | null;
  deletedAt: string;
  /** After this date the entity is purged for good. */
  expiresAt: string;
}

// ---------- dashboards ----------
interface WidgetBase {
  title?: string;
  /** Columns out of 12. */
  width: number;
}

export interface InsightsConfig {
  days: number;
  team?: string;
  service?: string;
  deployments: {
    blueprint: string;
    timeProperty: string;
    statusProperty: string;
    successValues: string[];
    failureValues: string[];
    mergedProperty: string;
    serviceRelation: string;
  };
  deploymentActions: string[];
  incidents: { blueprint: string; createdProperty: string; resolvedProperty: string; serviceRelation: string };
}

export type DoraBand = 'elite' | 'high' | 'medium' | 'low';

/** The four DORA metrics; a metric without data is `value: null` (never NaN) and has no band. */
export interface Insights {
  days: number;
  since: string;
  until: string;
  deploymentFrequency: { value: number | null; unit: 'per_day'; count: number; band: DoraBand | null };
  leadTime: { value: number | null; unit: 'hours'; samples: number; band: DoraBand | null };
  changeFailureRate: { value: number | null; unit: 'ratio'; failed: number; total: number; band: DoraBand | null };
  mttr: { value: number | null; unit: 'hours'; incidents: number; band: DoraBand | null };
}

export type DashboardWidget =
  | (WidgetBase & { type: 'count'; blueprint: string; filters: Record<string, string>; groupBy?: string })
  | (WidgetBase & { type: 'scorecard'; scorecard: string })
  | (WidgetBase & { type: 'runs'; limit: number; mine: boolean; status?: RunStatus[]; action?: string })
  | (WidgetBase & { type: 'approvals'; limit: number })
  | (WidgetBase & {
      type: 'table';
      blueprint: string;
      filters: Record<string, string>;
      search?: string;
      sort: 'title' | 'updated' | 'identifier';
      columns: string[];
      limit: number;
    })
  | (WidgetBase & { type: 'insights' } & InsightsConfig)
  | (WidgetBase & { type: 'markdown'; content: string });

export interface Dashboard {
  identifier: string;
  title: string;
  description: string;
  team: string | null;
  blueprint: string | null;
  default: boolean;
  widgets: DashboardWidget[];
  managed: boolean;
}

/** Computed data of one widget, in the order of the dashboard's widgets. */
export type WidgetData =
  | { error: string }
  | { type: 'count'; value: number; groups?: { key: string; count: number }[] }
  | { type: 'scorecard'; scorecard: string; title: string; levels: ScorecardLevel[]; distribution: Record<string, number>; total: number }
  | { type: 'runs'; items: Run[]; total: number }
  | { type: 'approvals'; items: Run[]; total: number }
  | { type: 'table'; blueprint: string; items: Entity[]; total: number }
  | ({ type: 'insights' } & Insights)
  | { type: 'markdown' };

// ---- preferences/views ----
/** Per-user, per-organization preferences (GET/PUT /api/v1/me/preferences). Form drafts stay in the browser. */
export interface UserPreferences {
  /** Favourite actions (identifiers). */
  favourites?: string[];
  /** Recently started actions, most recent first. */
  recentActions?: string[];
  /** Columns picked for the catalog table of a blueprint: `catalog.columns.<blueprint>`. */
  [key: `catalog.columns.${string}`]: string[] | undefined;
}

/** A saved catalog view: a named catalog query string, private or shared with one team. */
export interface SavedCatalogView {
  id: string;
  name: string;
  blueprint: string;
  /** Catalog URL query string (search, team, sort, filters…), without the page. */
  query: string;
  team: TeamRef | null;
  owner: { id: string; name: string };
  /** Owned by the caller. */
  mine: boolean;
  /** The caller may rename, re-share or delete it (owner or admin). */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}
