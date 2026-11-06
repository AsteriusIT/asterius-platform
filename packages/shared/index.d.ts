/**
 * Types shared by the Asterius Platform server and web UI (API shapes).
 * Declarations only: the server validates input with zod (apps/server/src/schemas.ts).
 */

// ---------- identity ----------
export type Role = 'admin' | 'member';
export type UserProvider = 'local' | 'entra' | 'service';

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
  teams: TeamRef[];
  active: boolean;
  lastLoginAt?: string | null;
  /** Onboarding tour completed or skipped; null: show it at next sign-in. */
  tourCompletedAt?: string | null;
}

export interface Team {
  identifier: string;
  title: string;
  description: string;
  /** Members of this Entra ID group are members of the team (synchronised at sign-in). */
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
}

// ---------- catalog ----------
/** A JSON Schema subset, extended with UI formats. */
export interface PropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  title?: string;
  description?: string;
  /** url · email · date · date-time · markdown · yaml · team · user · entity (with `blueprint`) */
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
}

export interface Blueprint {
  identifier: string;
  title: string;
  description: string;
  icon: string | null;
  schema: ObjectSchema;
  relations: Record<string, BlueprintRelation>;
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
  /** Who writes this entity: an integration identifier, `api`, `ui` or `config`. */
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntityPage {
  items: Entity[];
  total: number;
}

export interface RelatedEntities {
  /** Entities this entity points to, by relation name. */
  outgoing: Record<string, Entity[]>;
  /** Entities pointing to this one: `<blueprint>.<relation>` → entities. */
  incoming: Record<string, Entity[]>;
}

// ---------- self-service ----------
export type ActionTrigger = 'create' | 'day-2' | 'delete';

/** Who: roles, teams, users (emails), and/or the team owning the target entity. Empty = everyone. */
export interface Subjects {
  roles?: Role[];
  teams?: string[];
  users?: string[];
  ownerTeam?: boolean;
}

export interface ApprovalPolicy {
  required: boolean;
  approvers?: Subjects;
  minApprovals?: number;
  allowSelfApproval?: boolean;
}

export interface InvokerConfig {
  type: string;
  [k: string]: unknown;
}

// ---------- workflows ----------
export type WorkflowStepType = 'invoke' | 'approval' | 'agent' | 'transform' | 'wait' | 'input' | 'workflow';

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
}

export interface InvokeStep extends WorkflowStepBase {
  type: 'invoke';
  invoker: InvokerConfig;
}

export interface ApprovalStep extends WorkflowStepBase {
  type: 'approval';
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

export interface AgentStep extends WorkflowStepBase {
  type: 'agent';
  model?: string;
  effort?: AgentEffort;
  system?: string;
  prompt: string;
  /** Structured output: the step output follows this schema. Without it the output is `{ text }`. */
  output?: ObjectSchema;
  /** Read-only tools the model may call. */
  tools?: 'catalog'[];
  maxTurns?: number;
  maxTokens?: number;
  /** `${secret:NAME}` reference; default: the platform's ANTHROPIC_API_KEY. */
  apiKey?: string;
}

export interface TransformStep extends WorkflowStepBase {
  type: 'transform';
  /** Output key → JSONata expression. */
  output: Record<string, string>;
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
}

/** Run another action as a child workflow (optionally once per item of a list) and wait for the result. */
export interface WorkflowCallStep extends WorkflowStepBase {
  type: 'workflow';
  action: string;
  inputs?: Record<string, unknown>;
  entity?: string;
  forEach?: { items: string; maxConcurrency?: number; failFast?: boolean };
}

export type WorkflowStep = InvokeStep | ApprovalStep | AgentStep | TransformStep | WaitStep | InputStep | WorkflowCallStep;

export type StepStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'WAITING_APPROVAL' | 'WAITING' | 'SUCCESS' | 'FAILURE' | 'SKIPPED' | 'CANCELLED';

export interface RunStep {
  id: string;
  name: string;
  type: WorkflowStepType;
  needs: string[];
  status: StepStatus;
  statusLabel: string | null;
  attempt: number;
  maxAttempts: number;
  continueOnError: boolean;
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
  approvals: RunApproval[];
  canApprove?: boolean;
  /** A failed step the caller may retry. */
  canRetry?: boolean;
  startedAt: string | null;
  endedAt: string | null;
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
  /** Next planned tick (read-only). */
  nextRunAt?: string | null;
}

export interface EventTrigger {
  type: 'event';
  event: 'entity.created' | 'entity.updated' | 'entity.deleted' | 'run.finished';
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
  /** Non-admins only see each step's id, name and type (no configuration). */
  steps: WorkflowStep[];
  /** Legacy single-invoker form (configuration files), when the action was declared with `invoker`. */
  invoker?: InvokerConfig;
  enabled: boolean;
  managed: boolean;
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
}

export type RunStatus = 'PENDING_APPROVAL' | 'QUEUED' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILURE' | 'REJECTED' | 'CANCELLED';

export interface RunLog {
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
  steps?: RunStep[];
  /** Approvals page: the step waiting for the caller's decision (null: the run-level approval). */
  pendingStep?: { id: string; name: string; message: string | null; kind?: 'approval' | 'input' } | null;
  canApprove?: boolean;
  canCancel?: boolean;
  /** Requester or admin, finished run. */
  canRerun?: boolean;
  /** Requester or admin, failed or cancelled run with steps to start over. */
  canResume?: boolean;
}

export interface RunPage {
  items: Run[];
  total: number;
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

export interface SyncRun {
  id: string;
  integration: string;
  trigger: 'schedule' | 'manual' | 'webhook' | 'startup';
  status: 'running' | 'success' | 'failure';
  stats: SyncStats;
  logs: string[];
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
  managed: boolean;
  lastSync: SyncRun | null;
  /** Webhook integrations: where third parties POST events. */
  webhookUrl?: string;
}

// ---------- outbound webhooks ----------
export interface Webhook {
  identifier: string;
  title: string;
  url: string;
  /** entity.created · entity.updated · entity.deleted · run.created · run.updated, or `*` / `entity.*` */
  events: string[];
  blueprints: string[];
  enabled: boolean;
  managed: boolean;
  hasSecret: boolean;
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

export interface Meta {
  name: string;
  version: string;
  authProviders: ('local' | 'entra')[];
  allowRegistration: boolean;
  invokers: PluginInfo[];
  sources: PluginInfo[];
}

export interface HomeSummary {
  blueprints: { identifier: string; title: string; icon: string | null; count: number }[];
  pendingApprovals: number;
  myRuns: Run[];
  recentEntities: Entity[];
}
