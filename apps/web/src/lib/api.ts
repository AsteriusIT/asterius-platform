import type {
  Action,
  AiBudget,
  AiPrice,
  AiReview,
  WorkflowStep,
  AiStatus,
  AiUsageReport,
  ApiToken,
  AuditEntry,
  Blueprint,
  Dashboard,
  Delivery,
  Entity,
  EntityMigration,
  EntityPage,
  EntityVersion,
  HomeSummary,
  Integration,
  InvalidEntity,
  Member,
  Meta,
  Organization,
  OrgMembership,
  PublicUser,
  SsoProvider,
  SsoProviderInput,
  ConfigSource,
  RelatedEntities,
  Run,
  RunPage,
  Policy,
  Scorecard,
  ScorecardResult,
  ScorecardSummary,
  SecretInfo,
  SecretProviderInfo,
  SyncRun,
  Team,
  Tombstone,
  Webhook,
  WidgetData,
  ActionVersion,
  ActionVersionDiff,
  NotificationPrefs,
  NotificationSettings,
  EntityGraph as SharedGraph,
  DryRunResult,
} from '@asterius/shared';

export interface SimulationResult {
  steps: { id: string; type: string; skipped: boolean; error?: string; preview?: unknown }[];
}

export interface ConfigInfo {
  /** Directory of the files; null for Git or 'none' sources. */
  dir: string | null;
  source?: ConfigSource;
  managed: Record<string, number>;
  status: { lastCheckedAt: string | null; lastAppliedAt: string | null; hash: string | null; files: number; error: string | null };
}
export interface ConfigDiff {
  error: string | null;
  pending?: boolean;
  kinds: Record<string, { added: string[]; removed: string[]; kept: string[] }>;
}

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  read: boolean;
}
export interface InboxPrefs {
  email: boolean;
  slack: boolean;
}

export interface EntityGraph {
  nodes: { id: string; blueprint: string; identifier: string; title: string; depth: number }[];
  edges: { from: string; to: string; relation: string }[];
  truncated: boolean;
}

/** Typed client for the platform API (/api/v1). The session token lives in localStorage. */

const TOKEN_KEY = 'asterius.token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string | null) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode */
    }
  },
};

/**
 * Cookie sessions (SESSION_COOKIE on the server): the browser holds an httpOnly cookie, so the token store only keeps
 * the marker `cookie`, and unsafe requests carry a CSRF token (kept in memory, restored from /api/auth/me).
 */
export const COOKIE_SESSION = 'cookie';
let csrf: string | null = null;
export const setCsrf = (t: string | undefined) => {
  if (t) csrf = t;
};

/** The organization the UI works in (slug), sent as X-Asterius-Org. The server falls back to the last one used. */
const ORG_KEY = 'asterius.org';
export const orgStore = {
  get: () => {
    try {
      return localStorage.getItem(ORG_KEY);
    } catch {
      return null;
    }
  },
  set: (slug: string | null) => {
    try {
      if (slug) localStorage.setItem(ORG_KEY, slug);
      else localStorage.removeItem(ORG_KEY);
    } catch {
      /* private mode */
    }
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => undefined;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const token = tokenStore.get();
  const viaCookie = token === COOKIE_SESSION;
  const org = orgStore.get();
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(token && !viaCookie ? { authorization: `Bearer ${token}` } : {}),
      ...(viaCookie && csrf ? { 'x-csrf-token': csrf } : {}),
      ...(org ? { 'x-asterius-org': org } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized();
  const text = await res.text();
  const data = text && (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
  const err = data as { error?: string; code?: string };
  // Removed from the remembered organization (or it was deleted): forget it and let the server pick another.
  if (res.status === 403 && org && !retried && /member of this organization/.test(err?.error ?? '')) {
    orgStore.set(null);
    return request<T>(method, path, body, true);
  }
  if (!res.ok) throw new ApiError(res.status, err?.error ?? `${res.status} ${res.statusText}`, err?.code);
  return data as T;
}

const v1 = (p: string) => `/api/v1${p}`;
const enc = encodeURIComponent;
const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface ImpactReport {
  total: number;
  invalid: number;
  samples: InvalidEntity[];
  truncated: boolean;
}

export type ActionView = Action & { allowedForMe?: boolean };

/** V2 run timeline (GET /runs/:id/timeline): the run, the catalog transitions, Loki logs and Tempo traces in one list. */
export interface TimelineEvent {
  time: string;
  step: string;
  status: 'success' | 'failure' | 'running' | 'info';
  symbol: string;
  message?: string;
  source: string;
  traceId?: string;
}
export interface RunTimeline {
  runId: string;
  events: TimelineEvent[];
  sources: { name: string; status: 'ok' | 'unconfigured' | 'error'; count: number; error?: string }[];
  entity: { blueprint: string; identifier: string; lifecycle?: string } | null;
  terminal: boolean;
  cached: boolean;
  cachedAt?: string;
}

/** V2 form preview (POST /actions/:id/preview): the Service spec, the policy result and the resources to be created. */
export interface ServicePreview {
  supported: boolean;
  step?: string;
  inputErrors?: string[];
  canSubmit?: boolean;
  operation?: string;
  specPath?: string;
  specYaml?: string | null;
  allowed?: boolean | null;
  error?: string;
  policy?: { status: 'allowed' | 'denied' | 'unavailable'; allowed: boolean | null; violations: { policy: string; msg: string }[]; error?: string };
  render?: {
    status: 'ok' | 'unavailable' | 'error' | 'skipped';
    /** Plan service (`tofu plan`): kind = resource type, name = address, action = create | import | update | delete | no-op. */
    resources: { apiVersion?: string; kind: string; name: string; externalName?: string | null; action?: string; replace?: boolean }[];
    error?: string;
  };
  /** The spec validated against the Service schema of the Portal repo (violations are also in `policy`). */
  schema?: {
    status: 'valid' | 'invalid' | 'unavailable' | 'skipped';
    violations: { policy: string; msg: string }[];
    version?: string;
    source?: string;
    error?: string;
  };
}

export const api = {
  checkExpression: (expression: string, context?: unknown) =>
    request<{ ok: boolean; value?: unknown; error?: string }>('POST', v1('/expressions/check'), { expression, context }),
  simulate: (steps: unknown[], inputs: Record<string, unknown>) => request<SimulationResult>('POST', v1('/actions/dry-run'), { steps, inputs }),
  meta: () => request<Meta>('GET', '/api/meta'),
  login: (email: string, password: string) =>
    request<{ token: string; csrfToken?: string; user: PublicUser }>('POST', '/api/auth/login', { email, password }).then((r) => (setCsrf(r.csrfToken), r)),
  register: (email: string, name: string, password: string, bootstrapToken?: string) =>
    request<{ token: string; csrfToken?: string; user: PublicUser }>('POST', '/api/auth/register', {
      email,
      name,
      password,
      ...(bootstrapToken ? { bootstrapToken } : {}),
    }).then((r) => (setCsrf(r.csrfToken), r)),
  logout: () => request<{ ok: true; redirect?: string }>('POST', '/api/auth/logout'),
  me: () => request<PublicUser & { csrfToken?: string }>('GET', '/api/auth/me').then((u) => (setCsrf(u.csrfToken), u)),
  setTourCompleted: (completed: boolean) => request<PublicUser>('PUT', '/api/auth/me/tour', { completed }),

  home: () => request<HomeSummary>('GET', v1('/home')),

  blueprints: () => request<Blueprint[]>('GET', v1('/blueprints')),
  blueprint: (bp: string) => request<Blueprint>('GET', v1(`/blueprints/${enc(bp)}`)),
  saveBlueprint: (bp: string, body: unknown) => request<Blueprint>('PUT', v1(`/blueprints/${enc(bp)}`), body),
  blueprintImpact: (bp: string, blueprint: unknown, migrations: EntityMigration[] = []) =>
    request<ImpactReport>('POST', v1(`/blueprints/${enc(bp)}/impact`), { blueprint, migrations }),
  migrateBlueprint: (bp: string, migrations: EntityMigration[]) =>
    request<{ migrated: number; total: number }>('POST', v1(`/blueprints/${enc(bp)}/migrate`), { migrations }),
  deleteBlueprint: (bp: string) => request('DELETE', v1(`/blueprints/${enc(bp)}`)),

  entities: (q: {
    blueprint?: string;
    search?: string;
    team?: string;
    sort?: string;
    order?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
    filters?: Record<string, string>;
  }) => {
    const { blueprint, filters, ...rest } = q;
    const f = Object.fromEntries(Object.entries(filters ?? {}).map(([k, v]) => [`filter.${k}`, v]));
    return request<EntityPage>('GET', v1(`${blueprint ? `/blueprints/${enc(blueprint)}` : ''}/entities${qs({ ...rest, ...f })}`));
  },
  entityGraph: async (bp: string, id: string, depth = 2): Promise<EntityGraph> => {
    const g = await request<SharedGraph>('GET', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}/graph${qs({ depth, direction: 'both' })}`));
    const key = (n: { blueprint: string; identifier: string }) => `${n.blueprint}/${n.identifier}`;
    return {
      nodes: g.nodes.map((n) => ({ id: key(n), blueprint: n.blueprint, identifier: n.identifier, title: n.title, depth: n.depth })),
      edges: g.edges.map((e) => ({ from: key(e.from), to: key(e.to), relation: e.relation })),
      truncated: g.truncated,
    };
  },
  entity: (bp: string, id: string) => request<Entity>('GET', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}`)),
  entityDocs: (bp: string, id: string) =>
    request<{ property: string; url: string; markdown: string }>('GET', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}/docs`)),
  related: (bp: string, id: string) => request<RelatedEntities>('GET', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}/related`)),
  createEntity: (bp: string, body: unknown) => request<Entity>('POST', v1(`/blueprints/${enc(bp)}/entities`), body),
  saveEntity: (bp: string, id: string, body: unknown) => request<Entity>('PUT', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}`), body),
  deleteEntity: (bp: string, id: string) => request('DELETE', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}`)),
  history: (bp: string, id: string) => request<{ items: EntityVersion[]; total: number }>('GET', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}/history`)),
  revertEntity: (bp: string, id: string, version: number) =>
    request<Entity>('POST', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}/history/${version}/revert`), {}),
  deletedEntities: (q: { limit?: number; offset?: number } = {}) => request<{ items: Tombstone[]; total: number }>('GET', v1(`/deleted-entities${qs(q)}`)),
  restoreEntity: (bp: string, id: string) => request<Entity>('POST', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}/restore`), {}),
  purgeEntity: (bp: string, id: string) => request('DELETE', v1(`/deleted-entities/${enc(bp)}/${enc(id)}`)),
  entityActions: (bp: string, id: string) => request<ActionView[]>('GET', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}/actions`)),

  actionVersions: (id: string) => request<ActionVersion[]>('GET', v1(`/actions/${enc(id)}/versions`)),
  actionDiff: (id: string, from: number, to: number) =>
    request<ActionVersionDiff>('GET', v1(`/actions/${enc(id)}/diff${qs({ from: String(from), to: String(to) })}`)),
  rollbackAction: (id: string, version: number) => request<ActionView>('POST', v1(`/actions/${enc(id)}/rollback`), { version }),
  dryRun: (
    id: string,
    body: { definition?: Record<string, unknown>; inputs: Record<string, unknown>; entity?: string | null; mock?: Record<string, unknown> },
  ) => request<DryRunResult>('POST', v1(`/actions/${enc(id)}/dry-run`), body),
  notificationSettings: () => request<NotificationSettings>('GET', v1('/notification-settings')),
  saveNotificationSettings: (s: NotificationSettings) => request<NotificationSettings>('PUT', v1('/notification-settings'), s),
  testNotification: (channel: 'slack' | 'teams' | 'email') => request<{ ok: boolean }>('POST', v1('/notification-settings/test'), { channel }),
  notificationChannels: () => request<{ email: boolean; slack: boolean }>('GET', v1('/notifications/channels')),
  myNotifications: () => request<NotificationPrefs>('GET', v1('/me/notifications')),
  saveMyNotifications: (p: NotificationPrefs) => request<NotificationPrefs>('PUT', v1('/me/notifications'), p),
  actions: (q: { blueprint?: string; trigger?: string } = {}) => request<ActionView[]>('GET', v1(`/actions${qs(q)}`)),
  action: (id: string) => request<Action>('GET', v1(`/actions/${enc(id)}`)),
  saveAction: (id: string, body: unknown) => request<Action>('PUT', v1(`/actions/${enc(id)}`), body),
  deleteAction: (id: string) => request('DELETE', v1(`/actions/${enc(id)}`)),
  trigger: (id: string, body: { entity?: string | null; inputs: Record<string, unknown> }) => request<Run>('POST', v1(`/actions/${enc(id)}/runs`), body),
  previewAction: (id: string, body: { entity?: string | null; inputs: Record<string, unknown> }) =>
    request<ServicePreview>('POST', v1(`/actions/${enc(id)}/preview`), body),

  runTimeline: (id: string) => request<RunTimeline>('GET', v1(`/runs/${enc(id)}/timeline`)),
  runs: (q: { mine?: boolean; status?: string; action?: string; blueprint?: string; entity?: string; limit?: number; offset?: number }) =>
    request<RunPage>('GET', v1(`/runs${qs(q)}`)),
  /** `after`: only log lines past this sequence number (incremental polling). */
  run: (id: string, after?: number) => request<Run>('GET', v1(`/runs/${enc(id)}${after !== undefined ? `?after=${after}` : ''}`)),
  approvals: () => request<Run[]>('GET', v1('/approvals')),
  approve: (id: string, comment: string) => request<Run>('POST', v1(`/runs/${enc(id)}/approve`), { comment }),
  reject: (id: string, comment: string) => request<Run>('POST', v1(`/runs/${enc(id)}/reject`), { comment }),
  rerun: (id: string) => request<Run>('POST', v1(`/runs/${enc(id)}/rerun`), {}),
  resume: (id: string) => request<Run>('POST', v1(`/runs/${enc(id)}/resume`), {}),
  retryStep: (id: string, step: string) => request<Run>('POST', v1(`/runs/${enc(id)}/steps/${enc(step)}/retry`), {}),
  cancel: (id: string) => request<Run>('POST', v1(`/runs/${enc(id)}/cancel`), {}),
  approveStep: (id: string, step: string, comment: string, extra: { choice?: string; values?: Record<string, unknown> } = {}) =>
    request<Run>('POST', v1(`/runs/${enc(id)}/steps/${enc(step)}/approve`), { comment, ...extra }),
  submitInput: (id: string, step: string, values: Record<string, unknown>) => request<Run>('POST', v1(`/runs/${enc(id)}/steps/${enc(step)}/input`), { values }),
  rejectStep: (id: string, step: string, comment: string) => request<Run>('POST', v1(`/runs/${enc(id)}/steps/${enc(step)}/reject`), { comment }),

  integrations: () => request<Integration[]>('GET', v1('/integrations')),
  integration: (id: string) => request<Integration>('GET', v1(`/integrations/${enc(id)}`)),
  syncs: (id: string) => request<SyncRun[]>('GET', v1(`/integrations/${enc(id)}/syncs`)),
  saveIntegration: (id: string, body: unknown) => request<Integration>('PUT', v1(`/integrations/${enc(id)}`), body),
  deleteIntegration: (id: string, deleteEntities = false) => request('DELETE', v1(`/integrations/${enc(id)}${qs({ deleteEntities })}`)),
  syncNow: (id: string) => request('POST', v1(`/integrations/${enc(id)}/sync`), {}),
  testIntegration: (body: { type: string; config: Record<string, unknown>; kind?: string }) =>
    request<{ ok: boolean; sample: unknown[]; error?: string; note?: string }>('POST', v1('/integrations/test'), body),
  testWebhook: (id: string) => request<{ queued: boolean }>('POST', v1(`/webhooks/${enc(id)}/test`), {}),
  notifications: (q: { unread?: boolean; limit?: number; offset?: number } = {}) =>
    request<{ items: NotificationItem[]; unread: number }>('GET', v1(`/notifications${qs(q)}`)),
  markNotificationsRead: (body: { ids?: string[]; all?: boolean }) => request<{ changed: number }>('POST', v1('/notifications/read'), body),
  notificationPrefs: () => request<InboxPrefs>('GET', v1('/notifications/preferences')),
  saveNotificationPrefs: (p: InboxPrefs) => request<InboxPrefs>('PUT', v1('/notifications/preferences'), p),
  previewMapping: (body: { mapping: unknown; item: unknown }) => request<{ mapped: unknown[]; skipped: number }>('POST', v1('/mappings/preview'), body),

  policies: () => request<Policy[]>('GET', v1('/policies')),
  savePolicy: (id: string, body: unknown) => request<Policy>('PUT', v1(`/policies/${enc(id)}`), body),
  deletePolicy: (id: string) => request('DELETE', v1(`/policies/${enc(id)}`)),
  scorecards: (blueprint?: string) => request<Scorecard[]>('GET', v1(`/scorecards${qs({ blueprint })}`)),
  saveScorecard: (id: string, body: unknown) => request<Scorecard>('PUT', v1(`/scorecards/${enc(id)}`), body),
  deleteScorecard: (id: string) => request('DELETE', v1(`/scorecards/${enc(id)}`)),
  scorecardSummary: (id: string, days = 30) => request<ScorecardSummary>('GET', v1(`/scorecards/${enc(id)}/summary${qs({ days })}`)),
  entityScorecards: (bp: string, id: string) => request<ScorecardResult[]>('GET', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}/scorecards`)),
  scorecardLevels: (bp: string, ids: string[]) =>
    request<Record<string, Record<string, string | null>>>('GET', v1(`/blueprints/${enc(bp)}/scorecard-levels${qs({ ids: ids.join(',') })}`)),

  dashboards: () => request<Dashboard[]>('GET', v1('/dashboards')),
  resolveDashboard: (blueprint?: string) => request<Dashboard | null>('GET', v1(`/dashboards/resolve${qs({ blueprint })}`)),
  dashboardData: (id: string) => request<WidgetData[]>('GET', v1(`/dashboards/${enc(id)}/data`)),
  saveDashboard: (id: string, body: unknown) => request<Dashboard>('PUT', v1(`/dashboards/${enc(id)}`), body),
  deleteDashboard: (id: string) => request('DELETE', v1(`/dashboards/${enc(id)}`)),

  webhooks: () => request<Webhook[]>('GET', v1('/webhooks')),
  webhook: (id: string) => request<Webhook & { secret: string | null }>('GET', v1(`/webhooks/${enc(id)}`)),
  saveWebhook: (id: string, body: unknown) => request<Webhook>('PUT', v1(`/webhooks/${enc(id)}`), body),
  deleteWebhook: (id: string) => request('DELETE', v1(`/webhooks/${enc(id)}`)),
  deliveries: (id: string) => request<Delivery[]>('GET', v1(`/webhooks/${enc(id)}/deliveries`)),
  redeliver: (id: string) => request('POST', v1(`/deliveries/${enc(id)}/redeliver`), {}),

  teams: () => request<Team[]>('GET', v1('/teams')),
  saveTeam: (id: string, body: unknown) => request<Team>('PUT', v1(`/teams/${enc(id)}`), body),
  deleteTeam: (id: string) => request('DELETE', v1(`/teams/${enc(id)}`)),
  users: () => request<PublicUser[]>('GET', v1('/users')),
  userLookup: () => request<{ id: string; name: string; email: string }[]>('GET', v1('/users/lookup')),
  updateUser: (id: string, body: { role?: string; active?: boolean; teams?: string[] }) => request<PublicUser>('PATCH', v1(`/users/${enc(id)}`), body),
  createServiceAccount: (body: { name: string; role: string; teams: string[] }) =>
    request<{ user: PublicUser; token: string }>('POST', v1('/service-accounts'), body),

  tokens: (all = false) => request<ApiToken[]>('GET', v1(`/tokens${qs({ all: all || undefined })}`)),
  createToken: (name: string, expiresInDays: number | null) => request<{ id: string; token: string }>('POST', v1('/tokens'), { name, expiresInDays }),
  deleteToken: (id: string) => request('DELETE', v1(`/tokens/${enc(id)}`)),

  secrets: () => request<SecretInfo[]>('GET', v1('/secrets')),
  secretProviders: () => request<SecretProviderInfo[]>('GET', v1('/secret-providers')),
  setSecret: (name: string, value: string, description: string) => request('PUT', v1(`/secrets/${enc(name)}`), { value, description }),
  deleteSecret: (name: string) => request('DELETE', v1(`/secrets/${enc(name)}`)),

  audit: (q: { search?: string; actor?: string; action?: string; target?: string; from?: string; to?: string; limit?: number; offset?: number }) =>
    request<AuditEntry[]>('GET', v1(`/audit${qs(q)}`)),
  auditExport: (q: { search?: string; action?: string; actor?: string; target?: string; from?: string; to?: string }, format: 'csv' | 'json') =>
    request<string>('GET', v1(`/audit/export${qs({ ...q, format })}`)),
  auditFacets: () =>
    request<{ actions: { value: string; count: number }[]; actors: { value: string; count: number }[] }>('GET', v1('/audit/facets')).then((f) => ({
      actions: f.actions.map((x) => x.value),
      actors: f.actors.map((x) => x.value),
    })),
  allDeliveries: (q: { status?: string; limit?: number; offset?: number }) => request<Delivery[]>('GET', v1(`/deliveries${qs(q)}`)),
  redeliverMany: (ids: string[]) => request<{ queued: number }>('POST', v1('/deliveries/redeliver'), { ids }),
  configDiff: () => request<ConfigDiff>('GET', v1('/config/diff')),
  configImport: (yaml: string, dryRun: boolean) => request<{ ok: boolean; counts: Record<string, number> }>('POST', v1('/config/import'), { yaml, dryRun }),
  aiStatus: () => request<AiStatus>('GET', v1('/ai/status')),
  aiUsage: () => request<AiUsageReport>('GET', v1('/ai/usage')),
  aiBudgets: () => request<AiBudget[]>('GET', v1('/ai/budgets')),
  setAiBudget: (b: { scope: AiBudget['scope']; key: string; softUsd: number | null; hardUsd: number | null }) => request<AiBudget>('PUT', v1('/ai/budgets'), b),
  deleteAiBudget: (id: string) => request('DELETE', v1(`/ai/budgets/${enc(id)}`)),
  aiPrices: () => request<AiPrice[]>('GET', v1('/ai/prices')),
  aiAsk: (question: string) => request<{ answer: string; costUsd: number | null }>('POST', v1('/ai/ask'), { question }),
  aiExplainRun: (id: string, mode: 'explain' | 'summarise') =>
    request<{ answer: string; costUsd: number | null }>('POST', v1(`/ai/runs/${enc(id)}/explain`), { mode }),
  aiSuggestMapping: (body: { blueprint: string; sample: unknown; hint?: string }) =>
    request<{ mapping: Record<string, unknown>; preview: unknown; costUsd: number | null }>('POST', v1('/ai/suggest-mapping'), body),
  aiDraftBlueprint: (body: { sample?: unknown; description?: string }) =>
    request<{ blueprint: Record<string, unknown>; costUsd: number | null }>('POST', v1('/ai/draft-blueprint'), body),
  aiDraftWorkflow: (description: string) =>
    request<{ title: string; description: string; steps: WorkflowStep[]; costUsd: number | null }>('POST', v1('/ai/draft-workflow'), { description }),
  aiReviews: () => request<AiReview[]>('GET', v1('/ai/reviews')),
  aiRunReview: () => request<AiReview>('POST', v1('/ai/reviews/run'), {}),

  configInfo: () => request<ConfigInfo>('GET', v1('/config')),
  configExport: () => request<string>('GET', v1('/config/export')),
  configStatus: () =>
    request<{ currentHash: string | null; appliedHash: string | null; appliedAt: string | null; errors: string[]; readError: string | null; inSync: boolean }>(
      'GET',
      v1('/config/status'),
    ),
  configPlan: () => request<Array<{ kind: string; identifier: string; action: string; changes?: string[] }>>('GET', v1('/config/plan')),
  configReload: () => request('POST', v1('/config/reload'), {}),
  // organizations
  myOrgs: () => request<OrgMembership[]>('GET', '/api/orgs'),
  allOrgs: () => request<Organization[]>('GET', '/api/orgs?all=true'),
  createOrg: (body: { slug: string; name: string; domains?: string[] }) => request<Organization>('POST', '/api/orgs', body),
  deleteOrgById: (id: string) => request<{ ok: true }>('DELETE', `/api/orgs/${enc(id)}`),
  org: () => request<Organization>('GET', v1('/org')),
  updateOrg: (patch: { name?: string; domains?: string[] }) => request<Organization>('PATCH', v1('/org'), patch),
  deleteOrg: (confirm: string) => request<{ ok: true }>('DELETE', v1('/org'), { confirm }),
  verifyDomain: (domain: string, trusted = false) => request<Organization>('POST', v1('/org/domains/verify'), { domain, trusted }),
  members: () => request<Member[]>('GET', v1('/org/members')),
  addMember: (email: string, role: 'admin' | 'member') => request<{ status: 'added' | 'invited' }>('POST', v1('/org/members'), { email, role }),
  setMemberRole: (id: string, role: 'admin' | 'member') => request<{ ok: true }>('PATCH', v1(`/org/members/${enc(id)}`), { role }),
  removeMember: (id: string) => request<{ ok: true }>('DELETE', v1(`/org/members/${enc(id)}`)),
  setConfigSource: (src: ConfigSource) => request<Organization>('PUT', v1('/org/config-source'), src),
  syncConfig: () => request<Organization>('POST', v1('/org/config/sync')),
  sso: () => request<{ available: boolean; enabled: boolean; providers: SsoProvider[] }>('GET', v1('/org/sso')),
  enableSso: () => request<Organization>('POST', v1('/org/sso/enable')),
  addSsoProvider: (p: SsoProviderInput) => request<SsoProvider>('POST', v1('/org/sso/providers'), p),
  removeSsoProvider: (alias: string) => request<{ ok: true }>('DELETE', v1(`/org/sso/providers/${enc(alias)}`)),
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
