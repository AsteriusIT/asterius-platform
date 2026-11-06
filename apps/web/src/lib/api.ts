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
  Meta,
  PublicUser,
  RelatedEntities,
  Run,
  RunPage,
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
  DryRunResult,
} from '@asterius/shared';

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

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => undefined;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = tokenStore.get();
  const viaCookie = token === COOKIE_SESSION;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(token && !viaCookie ? { authorization: `Bearer ${token}` } : {}),
      ...(viaCookie && csrf ? { 'x-csrf-token': csrf } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized();
  const text = await res.text();
  const data = text && (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? `${res.status} ${res.statusText}`);
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

export const api = {
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
  logout: () => request('POST', '/api/auth/logout'),
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

  entities: (q: { blueprint?: string; search?: string; team?: string; sort?: string; limit?: number; offset?: number; filters?: Record<string, string> }) => {
    const { blueprint, filters, ...rest } = q;
    const f = Object.fromEntries(Object.entries(filters ?? {}).map(([k, v]) => [`filter.${k}`, v]));
    return request<EntityPage>('GET', v1(`${blueprint ? `/blueprints/${enc(blueprint)}` : ''}/entities${qs({ ...rest, ...f })}`));
  },
  entity: (bp: string, id: string) => request<Entity>('GET', v1(`/blueprints/${enc(bp)}/entities/${enc(id)}`)),
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
  previewMapping: (body: { mapping: unknown; item: unknown }) => request<{ mapped: unknown[]; skipped: number }>('POST', v1('/mappings/preview'), body),

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

  audit: (q: { search?: string; action?: string; actor?: string; limit?: number; offset?: number }) => request<AuditEntry[]>('GET', v1(`/audit${qs(q)}`)),
  auditExport: (q: { search?: string; action?: string; actor?: string }, format: 'csv' | 'json') =>
    request<string>('GET', v1(`/audit/export${qs({ ...q, format })}`)),
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

  configInfo: () => request<{ dir: string; managed: Record<string, number> }>('GET', v1('/config')),
  configExport: () => request<string>('GET', v1('/config/export')),
  configStatus: () =>
    request<{ currentHash: string | null; appliedHash: string | null; appliedAt: string | null; errors: string[]; readError: string | null; inSync: boolean }>(
      'GET',
      v1('/config/status'),
    ),
  configPlan: () => request<Array<{ kind: string; identifier: string; action: string; changes?: string[] }>>('GET', v1('/config/plan')),
  configReload: () => request('POST', v1('/config/reload'), {}),
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
