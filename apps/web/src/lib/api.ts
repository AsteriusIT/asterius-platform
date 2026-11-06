import type {
  Action,
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
  SyncRun,
  Team,
  Tombstone,
  Webhook,
  WidgetData,
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
  const res = await fetch(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
  login: (email: string, password: string) => request<{ token: string; user: PublicUser }>('POST', '/api/auth/login', { email, password }),
  register: (email: string, name: string, password: string) =>
    request<{ token: string; user: PublicUser }>('POST', '/api/auth/register', { email, name, password }),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request<PublicUser>('GET', '/api/auth/me'),
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

  actions: (q: { blueprint?: string; trigger?: string } = {}) => request<ActionView[]>('GET', v1(`/actions${qs(q)}`)),
  action: (id: string) => request<Action>('GET', v1(`/actions/${enc(id)}`)),
  saveAction: (id: string, body: unknown) => request<Action>('PUT', v1(`/actions/${enc(id)}`), body),
  deleteAction: (id: string) => request('DELETE', v1(`/actions/${enc(id)}`)),
  trigger: (id: string, body: { entity?: string | null; inputs: Record<string, unknown> }) => request<Run>('POST', v1(`/actions/${enc(id)}/runs`), body),

  runs: (q: { mine?: boolean; status?: string; action?: string; blueprint?: string; entity?: string; limit?: number; offset?: number }) =>
    request<RunPage>('GET', v1(`/runs${qs(q)}`)),
  run: (id: string) => request<Run>('GET', v1(`/runs/${enc(id)}`)),
  approvals: () => request<Run[]>('GET', v1('/approvals')),
  approve: (id: string, comment: string) => request<Run>('POST', v1(`/runs/${enc(id)}/approve`), { comment }),
  reject: (id: string, comment: string) => request<Run>('POST', v1(`/runs/${enc(id)}/reject`), { comment }),
  cancel: (id: string) => request<Run>('POST', v1(`/runs/${enc(id)}/cancel`), {}),
  approveStep: (id: string, step: string, comment: string) => request<Run>('POST', v1(`/runs/${enc(id)}/steps/${enc(step)}/approve`), { comment }),
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
  setSecret: (name: string, value: string, description: string) => request('PUT', v1(`/secrets/${enc(name)}`), { value, description }),
  deleteSecret: (name: string) => request('DELETE', v1(`/secrets/${enc(name)}`)),

  audit: (q: { search?: string; limit?: number; offset?: number }) => request<AuditEntry[]>('GET', v1(`/audit${qs(q)}`)),
  configInfo: () => request<{ dir: string; managed: Record<string, number> }>('GET', v1('/config')),
  configExport: () => request<string>('GET', v1('/config/export')),
  configReload: () => request('POST', v1('/config/reload'), {}),
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
