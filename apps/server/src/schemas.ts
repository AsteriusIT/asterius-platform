import { z } from 'zod';

/**
 * Definitions of the configurable resources. The same schemas validate the admin API and the configuration files
 * of CONFIG_DIR, so a resource can be moved from the UI to Git (and back) unchanged.
 */

export const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;
export const slug = z.string().regex(SLUG, 'lowercase letters, digits, - and _ (starting with a letter, max 64)');
/** Entity identifiers come from third parties (e.g. `org/repo`, `ns/name`): keep them URL-friendly but permissive. */
export const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/@+=-]{0,199}$/;
export const entityId = z.string().regex(ENTITY_ID, 'letters, digits and _ . : / @ + = - (max 200)');

const propertySchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .object({
      type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object']),
      title: z.string().optional(),
      description: z.string().optional(),
      format: z.string().optional(),
      blueprint: z.string().optional(),
      enum: z.array(z.union([z.string(), z.number()])).optional(),
      items: propertySchema.optional(),
    })
    .passthrough(),
);

/** Property and relation names: usable as JSONata paths and JSON keys without quoting. */
const fieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'names: letters, digits and _ (starting with a letter)');

export const objectSchema = z
  .object({
    properties: z.record(fieldName, propertySchema).default({}),
    required: z.array(z.string()).optional(),
    order: z.array(z.string()).optional(),
  })
  .default({ properties: {} });

export const subjects = z
  .object({
    roles: z.array(z.enum(['admin', 'member'])).optional(),
    teams: z.array(z.string()).optional(),
    users: z.array(z.string()).optional(),
    ownerTeam: z.boolean().optional(),
  })
  .default({});

export const blueprintDef = z.object({
  identifier: slug,
  title: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
  icon: z.string().max(64).nullish(),
  schema: objectSchema,
  relations: z
    .record(
      fieldName,
      z.object({
        title: z.string().optional(),
        target: slug,
        many: z.boolean().default(false),
        required: z.boolean().default(false),
      }),
    )
    .default({}),
});
export type BlueprintDef = z.infer<typeof blueprintDef>;

export const scorecardDef = z
  .object({
    identifier: slug,
    title: z.string().min(1).max(100),
    description: z.string().max(2000).default(''),
    blueprint: slug,
    /** Ordered from the lowest to the highest (e.g. Bronze, Silver, Gold). An entity reaches a level when it passes every rule of that level and of the levels below. */
    levels: z
      .array(z.object({ name: z.string().min(1).max(40), color: z.string().max(30).optional() }))
      .min(1)
      .max(8),
    rules: z
      .array(
        z.object({
          identifier: fieldName,
          title: z.string().min(1).max(200),
          description: z.string().max(1000).optional(),
          /** Name of the level this rule belongs to. */
          level: z.string().min(1),
          /** JSONata over the entity (`properties`, `relations`, `related`, `team`…): passes when truthy. */
          expression: z.string().min(1).max(2000),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((s, ctx) => {
    const levels = new Set<string>();
    for (const l of s.levels) {
      if (levels.has(l.name)) ctx.addIssue({ code: 'custom', message: `Level "${l.name}" is declared twice`, path: ['levels'] });
      levels.add(l.name);
    }
    const ids = new Set<string>();
    s.rules.forEach((r, i) => {
      if (!levels.has(r.level))
        ctx.addIssue({ code: 'custom', message: `Rule "${r.identifier}" uses unknown level "${r.level}"`, path: ['rules', i, 'level'] });
      if (ids.has(r.identifier)) ctx.addIssue({ code: 'custom', message: `Rule "${r.identifier}" is declared twice`, path: ['rules', i, 'identifier'] });
      ids.add(r.identifier);
    });
  });
export type ScorecardDef = z.infer<typeof scorecardDef>;

export const invokerConfig = z.object({ type: z.string().min(1) }).passthrough();

/** Step ids are used in templates (`steps.<id>.output`): JSONata-friendly names. */
export const STEP_ID = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

const stepBase = {
  id: z.string().regex(STEP_ID, 'step ids: letters, digits and _ (starting with a letter)'),
  name: z.string().max(100).optional(),
  if: z.string().max(2000).optional(),
  needs: z.array(z.string()).optional(),
  retries: z.number().int().min(0).max(10).default(0),
  retryDelaySeconds: z.number().int().min(1).max(3600).default(30),
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 30)
    .optional(),
  continueOnError: z.boolean().default(false),
};

export const AGENT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] as const;

export const workflowStep = z.discriminatedUnion('type', [
  z.object({ ...stepBase, type: z.literal('invoke'), invoker: z.object({ type: z.string().min(1) }).passthrough() }),
  z.object({
    ...stepBase,
    type: z.literal('approval'),
    approvers: z
      .object({
        roles: z.array(z.enum(['admin', 'member'])).optional(),
        teams: z.array(z.string()).optional(),
        users: z.array(z.string()).optional(),
        ownerTeam: z.boolean().optional(),
      })
      .optional(),
    minApprovals: z.number().int().min(1).max(10).default(1),
    allowSelfApproval: z.boolean().default(false),
    message: z.string().max(20_000).optional(),
  }),
  z.object({
    ...stepBase,
    type: z.literal('agent'),
    /** Any Claude model id; the UI proposes the current ones. */
    model: z.string().min(1).max(100).default('claude-opus-5-5'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    system: z.string().max(50_000).optional(),
    prompt: z.string().min(1).max(100_000),
    output: z
      .object({
        properties: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.record(z.string(), z.unknown())),
        required: z.array(z.string()).optional(),
        order: z.array(z.string()).optional(),
      })
      .optional(),
    tools: z.array(z.enum(['catalog'])).default([]),
    maxTurns: z.number().int().min(1).max(20).default(6),
    maxTokens: z.number().int().min(256).max(64_000).default(16_000),
    apiKey: z.string().optional(),
  }),
  z.object({ ...stepBase, type: z.literal('transform'), output: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string()) }),
]);
export type WorkflowStepDef = z.infer<typeof workflowStep>;

const approvalPolicy = z
  .object({
    required: z.boolean().default(false),
    approvers: subjects.optional(),
    minApprovals: z.number().int().min(1).max(10).default(1),
    allowSelfApproval: z.boolean().default(false),
  })
  .default({ required: false, minApprovals: 1, allowSelfApproval: false });

/**
 * Workflow triggers. For now one type: `form`, a form submitted by a user (self-service page, or an entity page).
 * Other types (schedule, catalog event, webhook) will join this union.
 */
export const formTrigger = z.object({
  type: z.literal('form'),
  /** create: the self-service page · day-2 / delete: on an existing entity of `blueprint`. */
  on: z.enum(['create', 'day-2', 'delete']).default('create'),
  /** The kind of entity it creates or acts on (null: a general workflow). */
  blueprint: slug.nullish(),
  /** The form fields. */
  inputs: objectSchema,
  /** Who may submit it (empty: everyone). */
  allowed: subjects,
  /** Approval before the workflow starts (approval steps cover approvals in the middle). */
  approval: approvalPolicy,
});
export const workflowTrigger = z.discriminatedUnion('type', [formTrigger]);
export type WorkflowTriggerDef = z.infer<typeof workflowTrigger>;

/**
 * Before workflows had triggers, the form settings sat at the top level of an action:
 * `{ trigger: 'day-2', blueprint, inputs, allowed, approval }`. Such documents are converted on read.
 */
function legacyToTrigger(raw: unknown) {
  if (!raw || typeof raw !== 'object') return raw;
  const a = { ...(raw as Record<string, unknown>) };
  // The flat format (and single-invoker actions, which predate workflows) always had a form trigger.
  const legacy = typeof a.trigger === 'string' || ['blueprint', 'inputs', 'allowed', 'approval', 'invoker'].some((k) => k in a);
  if (!legacy || (a.trigger && typeof a.trigger === 'object')) return raw;
  const trigger = {
    type: 'form',
    on: typeof a.trigger === 'string' ? a.trigger : 'create',
    blueprint: a.blueprint,
    inputs: a.inputs,
    allowed: a.allowed,
    approval: a.approval,
  };
  for (const k of ['blueprint', 'inputs', 'allowed', 'approval']) delete a[k];
  return { ...a, trigger };
}

export const actionDef = z.preprocess(
  legacyToTrigger,
  z.object({
    identifier: slug,
    title: z.string().min(1).max(100),
    description: z.string().max(4000).default(''),
    icon: z.string().max(64).nullish(),
    /** What starts the workflow. Null: a draft that cannot run yet. */
    trigger: workflowTrigger.nullable().default(null),
    /** Legacy form: one invoker (= a one-step workflow). */
    invoker: invokerConfig.optional(),
    /** The workflow: steps run in order, or as a graph with `needs`. Empty: a draft. */
    steps: z.array(workflowStep).max(40).default([]),
    enabled: z.boolean().default(true),
  }),
);
export type ActionDef = z.infer<typeof actionDef>;

export const mappingDef = z.object({
  kind: z.string().default('item'),
  filter: z.string().optional(),
  items: z.string().optional(),
  delete: z.string().optional(),
  merge: z.boolean().default(false),
  entity: z.object({
    blueprint: slug,
    identifier: z.string().min(1),
    title: z.string().optional(),
    team: z.string().optional(),
    properties: z.record(z.string(), z.string()).default({}),
    relations: z.record(z.string(), z.string()).default({}),
  }),
});
export type MappingDef = z.infer<typeof mappingDef>;

export const integrationDef = z.object({
  identifier: slug,
  title: z.string().min(1).max(100),
  type: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  mappings: z.array(mappingDef).default([]),
  /** Pull integrations: minutes between synchronisations (0: manual only). */
  intervalMinutes: z.number().int().min(0).max(10080).default(60),
  /** After a successful full sync, delete the entities this integration created that it did not see anymore. */
  deleteMissing: z.boolean().default(false),
});
export type IntegrationDef = z.infer<typeof integrationDef>;

export const WEBHOOK_EVENTS = ['entity.created', 'entity.updated', 'entity.deleted', 'run.created', 'run.updated', 'scorecard.changed'] as const;

export const webhookDef = z.object({
  identifier: slug,
  title: z.string().min(1).max(100),
  url: z.string().url(),
  events: z
    .array(z.string().regex(/^(\*|entity\.\*|run\.\*|scorecard\.\*|entity\.(created|updated|deleted)|run\.(created|updated)|scorecard\.changed)$/))
    .min(1),
  blueprints: z.array(slug).default([]),
  /** Signing secret reference (`${secret:NAME}`): deliveries carry `X-Asterius-Signature: sha256=<hmac>`. */
  secret: z.string().nullish(),
  enabled: z.boolean().default(true),
});
export type WebhookDef = z.infer<typeof webhookDef>;

export const teamDef = z.object({
  identifier: slug,
  title: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  entraGroupId: z.string().nullish(),
});
export type TeamDef = z.infer<typeof teamDef>;

export const entityInput = z.object({
  identifier: entityId,
  title: z.string().max(200).optional(),
  team: z.string().nullish(),
  properties: z.record(z.string(), z.unknown()).default({}),
  relations: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])).default({}),
});
export type EntityInput = z.infer<typeof entityInput>;

/** Seed entities in configuration files: created when missing, never overwritten. */
export const seedEntity = entityInput.extend({ blueprint: slug });

export const configFile = z.object({
  teams: z.array(teamDef).default([]),
  blueprints: z.array(blueprintDef).default([]),
  actions: z.array(actionDef).default([]),
  integrations: z.array(integrationDef).default([]),
  webhooks: z.array(webhookDef).default([]),
  scorecards: z.array(scorecardDef).default([]),
  entities: z.array(seedEntity).default([]),
});
export type ConfigFile = z.infer<typeof configFile>;
