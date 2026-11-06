// Generated from docs/openapi.json (version 0.1.0) by `npm run clients:generate`. Do not edit.
/* eslint-disable */

export type Blueprint = {
  identifier: string;
  title: string;
  description?: string;
  icon?: string | null;
  schema?: {
    properties?: {
      [key: string]: Blueprint_schema0;
    };
    required?: Array<string>;
    order?: Array<string>;
  };
  relations?: {
    [key: string]: {
      title?: string;
      target: string;
      many?: boolean;
      required?: boolean;
    };
  };
};

export type Action = {
  identifier: string;
  title: string;
  description?: string;
  icon?: string | null;
  trigger?: {
    type: "form";
    on?: "create" | "day-2" | "delete";
    blueprint?: string | null;
    inputs?: {
      properties?: {
        [key: string]: Action_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    allowed?: {
      roles?: Array<"admin" | "member">;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    approval?: {
      required?: boolean;
      approvers?: {
        roles?: Array<"admin" | "member">;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      minApprovals?: number;
      allowSelfApproval?: boolean;
    };
  } | null;
  invoker?: {
    type: string;
    [key: string]: unknown;
  };
  steps?: Array<{
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    type: "invoke";
    invoker: {
      type: string;
      [key: string]: unknown;
    };
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    type: "approval";
    approvers?: {
      roles?: Array<"admin" | "member">;
      teams?: Array<string>;
      users?: Array<string>;
      ownerTeam?: boolean;
    };
    minApprovals?: number;
    allowSelfApproval?: boolean;
    message?: string;
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    type: "agent";
    model?: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    system?: string;
    prompt: string;
    output?: {
      properties: {
        [key: string]: {
          [key: string]: unknown;
        };
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    tools?: Array<"catalog">;
    maxTurns?: number;
    maxTokens?: number;
    apiKey?: string;
  } | {
    id: string;
    name?: string;
    if?: string;
    needs?: Array<string>;
    retries?: number;
    retryDelaySeconds?: number;
    timeoutMinutes?: number;
    continueOnError?: boolean;
    type: "transform";
    output: {
      [key: string]: string;
    };
  }>;
  enabled?: boolean;
};

export type Integration = {
  identifier: string;
  title: string;
  type: string;
  enabled?: boolean;
  config?: {
    [key: string]: unknown;
  };
  mappings?: Array<{
    kind?: string;
    filter?: string;
    items?: string;
    delete?: string;
    merge?: boolean;
    entity: {
      blueprint: string;
      identifier: string;
      title?: string;
      team?: string;
      properties?: {
        [key: string]: string;
      };
      relations?: {
        [key: string]: string;
      };
    };
  }>;
  intervalMinutes?: number;
  deleteMissing?: boolean;
  priority?: number;
  schedule?: string;
  deleteMaxPercent?: number;
  deleteDryRun?: boolean;
};

export type Webhook = {
  identifier: string;
  title: string;
  url: string;
  events: Array<string>;
  blueprints?: Array<string>;
  secret?: string | null;
  headers?: {
    [key: string]: string;
  };
  filter?: string | null;
  transform?: string | null;
  enabled?: boolean;
};

export type Team = {
  identifier: string;
  title: string;
  description?: string;
  entraGroupId?: string | null;
};

export type EntityInput = {
  identifier: string;
  title?: string;
  team?: string | null;
  properties?: {
    [key: string]: unknown;
  };
  relations?: {
    [key: string]: string | Array<string> | null;
  };
};

export type ConfigFile = {
  teams?: Array<{
    identifier: string;
    title: string;
    description?: string;
    entraGroupId?: string | null;
  }>;
  blueprints?: Array<{
    identifier: string;
    title: string;
    description?: string;
    icon?: string | null;
    schema?: {
      properties?: {
        [key: string]: ConfigFile_schema0;
      };
      required?: Array<string>;
      order?: Array<string>;
    };
    relations?: {
      [key: string]: {
        title?: string;
        target: string;
        many?: boolean;
        required?: boolean;
      };
    };
  }>;
  actions?: Array<{
    identifier: string;
    title: string;
    description?: string;
    icon?: string | null;
    trigger?: {
      type: "form";
      on?: "create" | "day-2" | "delete";
      blueprint?: string | null;
      inputs?: {
        properties?: {
          [key: string]: ConfigFile_schema0;
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      allowed?: {
        roles?: Array<"admin" | "member">;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      approval?: {
        required?: boolean;
        approvers?: {
          roles?: Array<"admin" | "member">;
          teams?: Array<string>;
          users?: Array<string>;
          ownerTeam?: boolean;
        };
        minApprovals?: number;
        allowSelfApproval?: boolean;
      };
    } | null;
    invoker?: {
      type: string;
      [key: string]: unknown;
    };
    steps?: Array<{
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      type: "invoke";
      invoker: {
        type: string;
        [key: string]: unknown;
      };
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      type: "approval";
      approvers?: {
        roles?: Array<"admin" | "member">;
        teams?: Array<string>;
        users?: Array<string>;
        ownerTeam?: boolean;
      };
      minApprovals?: number;
      allowSelfApproval?: boolean;
      message?: string;
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      type: "agent";
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      system?: string;
      prompt: string;
      output?: {
        properties: {
          [key: string]: {
            [key: string]: unknown;
          };
        };
        required?: Array<string>;
        order?: Array<string>;
      };
      tools?: Array<"catalog">;
      maxTurns?: number;
      maxTokens?: number;
      apiKey?: string;
    } | {
      id: string;
      name?: string;
      if?: string;
      needs?: Array<string>;
      retries?: number;
      retryDelaySeconds?: number;
      timeoutMinutes?: number;
      continueOnError?: boolean;
      type: "transform";
      output: {
        [key: string]: string;
      };
    }>;
    enabled?: boolean;
  }>;
  integrations?: Array<{
    identifier: string;
    title: string;
    type: string;
    enabled?: boolean;
    config?: {
      [key: string]: unknown;
    };
    mappings?: Array<{
      kind?: string;
      filter?: string;
      items?: string;
      delete?: string;
      merge?: boolean;
      entity: {
        blueprint: string;
        identifier: string;
        title?: string;
        team?: string;
        properties?: {
          [key: string]: string;
        };
        relations?: {
          [key: string]: string;
        };
      };
    }>;
    intervalMinutes?: number;
    deleteMissing?: boolean;
    priority?: number;
    schedule?: string;
    deleteMaxPercent?: number;
    deleteDryRun?: boolean;
  }>;
  webhooks?: Array<{
    identifier: string;
    title: string;
    url: string;
    events: Array<string>;
    blueprints?: Array<string>;
    secret?: string | null;
    headers?: {
      [key: string]: string;
    };
    filter?: string | null;
    transform?: string | null;
    enabled?: boolean;
  }>;
  entities?: Array<{
    identifier: string;
    title?: string;
    team?: string | null;
    properties?: {
      [key: string]: unknown;
    };
    relations?: {
      [key: string]: string | Array<string> | null;
    };
    blueprint: string;
  }>;
};

export type Entity = {
  blueprint: string;
  identifier: string;
  title: string;
  team: string | null;
  properties: {
    [key: string]: unknown;
  };
  relations: {
    [key: string]: unknown;
  };
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type SyncRun = {
  id: string;
  integration: string;
  trigger: "schedule" | "manual" | "webhook" | "startup";
  status: "running" | "success" | "partial" | "failure";
  stats: {
    upserted: number;
    deleted: number;
    skipped: number;
    failed: number;
  };
  logs: Array<string>;
  errors: Array<{
    mapping: string;
    key: string;
    message: string;
  }>;
  startedAt: string;
  endedAt: string | null;
};

export type IntegrationView = {
  identifier: string;
  title: string;
  type: string;
  enabled: boolean;
  config: {
    [key: string]: unknown;
  };
  mappings: Array<{
    kind: string;
    filter?: string;
    items?: string;
    delete?: string;
    merge: boolean;
    entity: {
      blueprint: string;
      identifier: string;
      title?: string;
      team?: string;
      properties: {
        [key: string]: string;
      };
      relations: {
        [key: string]: string;
      };
    };
  }>;
  intervalMinutes: number;
  deleteMissing: boolean;
  priority: number;
  schedule?: string;
  deleteMaxPercent: number;
  deleteDryRun: boolean;
  managed: boolean;
  lastSync: {
    id: string;
    integration: string;
    trigger: "schedule" | "manual" | "webhook" | "startup";
    status: "running" | "success" | "partial" | "failure";
    stats: {
      upserted: number;
      deleted: number;
      skipped: number;
      failed: number;
    };
    logs: Array<string>;
    errors: Array<{
      mapping: string;
      key: string;
      message: string;
    }>;
    startedAt: string;
    endedAt: string | null;
  } | null;
  lastSuccessAt: string | null;
  webhookUrl?: string;
};

export type WebhookView = {
  identifier: string;
  title: string;
  url: string;
  events: Array<string>;
  blueprints: Array<string>;
  secret?: string | null;
  headers: {
    [key: string]: string;
  };
  filter?: string | null;
  transform?: string | null;
  enabled: boolean;
  managed: boolean;
  hasSecret: boolean;
};

export type Delivery = {
  id: string;
  webhook: string;
  event: string;
  status: "pending" | "success" | "failed";
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
};

export type Run = {
  id: string;
  action: string;
  actionTitle: string;
  status: string;
  inputs: {
    [key: string]: unknown;
  };
  createdAt: string;
  endedAt: string | null;
  [key: string]: unknown;
};

export type ConfigStatus = {
  appliedHash: string | null;
  appliedAt: string | null;
  errors: Array<string>;
  readError: string | null;
  inSync: boolean;
  [key: string]: unknown;
};

export type EntityPage = {
  items: Array<unknown>;
  total: number;
};

export type RunPage = {
  items: Array<unknown>;
  total: number;
};

export type Blueprint_schema0 = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  format?: string;
  blueprint?: string;
  enum?: Array<string | number>;
  items?: Blueprint_schema0;
  [key: string]: unknown;
};

export type Action_schema0 = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  format?: string;
  blueprint?: string;
  enum?: Array<string | number>;
  items?: Action_schema0;
  [key: string]: unknown;
};

export type ConfigFile_schema0 = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  format?: string;
  blueprint?: string;
  enum?: Array<string | number>;
  items?: ConfigFile_schema0;
  [key: string]: unknown;
};

export type Error = {
  error: string;
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export interface ClientOptions {
  /** Base URL of the platform, e.g. https://portal.example.com */
  baseUrl: string;
  /** Personal API token (Admin → Tokens) */
  token: string;
  fetch?: typeof fetch;
}

export class AsteriusClient {
  constructor(private options: ClientOptions) {}

  private async request<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await (this.options.fetch ?? fetch)(url, {
      method,
      headers: { authorization: `Bearer ${this.options.token}`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | undefined)?.error ?? res.statusText, data);
    return data as T;
  }

  /** GET /api/descriptor-schema.json */
  getDescriptorSchemaJson(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/descriptor-schema.json`, { query });
  }

  /** GET /api/meta */
  getMeta(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/meta`, { query });
  }

  /** GET /api/v1/actions */
  getActions(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/actions`, { query });
  }

  /** DELETE /api/v1/actions/{id} */
  deleteActionsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/actions/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/actions/{id} */
  getActionsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/actions/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/actions/{id} */
  putActionsById(id: string, body: Action, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/actions/${encodeURIComponent(id)}`, { query, body });
  }

  /** POST /api/v1/actions/{id}/runs */
  postActionsRunsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/actions/${encodeURIComponent(id)}/runs`, { query });
  }

  /** GET /api/v1/approvals */
  getApprovals(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/approvals`, { query });
  }

  /** GET /api/v1/audit */
  getAudit(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/audit`, { query });
  }

  /** GET /api/v1/blueprints */
  getBlueprints(query?: Record<string, string | number | undefined>): Promise<Array<Blueprint>> {
    return this.request('GET', `/api/v1/blueprints`, { query });
  }

  /** DELETE /api/v1/blueprints/{bp} */
  deleteBlueprintsByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/blueprints/${encodeURIComponent(bp)}`, { query });
  }

  /** GET /api/v1/blueprints/{bp} */
  getBlueprintsByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<Blueprint> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}`, { query });
  }

  /** PUT /api/v1/blueprints/{bp} */
  putBlueprintsByBp(bp: string, body: Blueprint, query?: Record<string, string | number | undefined>): Promise<Blueprint> {
    return this.request('PUT', `/api/v1/blueprints/${encodeURIComponent(bp)}`, { query, body });
  }

  /** GET /api/v1/blueprints/{bp}/entities */
  getBlueprintsEntitiesByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<EntityPage> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities`, { query });
  }

  /** POST /api/v1/blueprints/{bp}/entities */
  postBlueprintsEntitiesByBp(bp: string, body: EntityInput, query?: Record<string, string | number | undefined>): Promise<Entity> {
    return this.request('POST', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities`, { query, body });
  }

  /** DELETE /api/v1/blueprints/{bp}/entities/{id} */
  deleteBlueprintsEntitiesByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/blueprints/{bp}/entities/{id} */
  getBlueprintsEntitiesByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<Entity> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}`, { query });
  }

  /** PATCH /api/v1/blueprints/{bp}/entities/{id} */
  patchBlueprintsEntitiesByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PATCH', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/blueprints/{bp}/entities/{id} */
  putBlueprintsEntitiesByBpId(bp: string, id: string, body: EntityInput, query?: Record<string, string | number | undefined>): Promise<Entity> {
    return this.request('PUT', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}`, { query, body });
  }

  /** GET /api/v1/blueprints/{bp}/entities/{id}/actions */
  getBlueprintsEntitiesActionsByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}/actions`, { query });
  }

  /** GET /api/v1/blueprints/{bp}/entities/{id}/related */
  getBlueprintsEntitiesRelatedByBpId(bp: string, id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/${encodeURIComponent(id)}/related`, { query });
  }

  /** POST /api/v1/blueprints/{bp}/entities/bulk */
  postBlueprintsEntitiesBulkByBp(bp: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/blueprints/${encodeURIComponent(bp)}/entities/bulk`, { query });
  }

  /** GET /api/v1/config */
  getConfig(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/config`, { query });
  }

  /** GET /api/v1/config/export */
  getConfigExport(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/config/export`, { query });
  }

  /** GET /api/v1/config/plan */
  getConfigPlan(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/config/plan`, { query });
  }

  /** POST /api/v1/config/reload */
  postConfigReload(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/config/reload`, { query });
  }

  /** GET /api/v1/config/status */
  getConfigStatus(query?: Record<string, string | number | undefined>): Promise<ConfigStatus> {
    return this.request('GET', `/api/v1/config/status`, { query });
  }

  /** GET /api/v1/deliveries */
  getDeliveries(query?: Record<string, string | number | undefined>): Promise<Array<Delivery>> {
    return this.request('GET', `/api/v1/deliveries`, { query });
  }

  /** POST /api/v1/deliveries/{id}/redeliver */
  postDeliveriesRedeliverById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/deliveries/${encodeURIComponent(id)}/redeliver`, { query });
  }

  /** POST /api/v1/deliveries/redeliver-failed */
  postDeliveriesRedeliverFailed(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/deliveries/redeliver-failed`, { query });
  }

  /** GET /api/v1/entities */
  getEntities(query?: Record<string, string | number | undefined>): Promise<EntityPage> {
    return this.request('GET', `/api/v1/entities`, { query });
  }

  /** GET /api/v1/home */
  getHome(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/home`, { query });
  }

  /** GET /api/v1/integrations */
  getIntegrations(query?: Record<string, string | number | undefined>): Promise<Array<IntegrationView>> {
    return this.request('GET', `/api/v1/integrations`, { query });
  }

  /** DELETE /api/v1/integrations/{id} */
  deleteIntegrationsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/integrations/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/integrations/{id} */
  getIntegrationsById(id: string, query?: Record<string, string | number | undefined>): Promise<IntegrationView> {
    return this.request('GET', `/api/v1/integrations/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/integrations/{id} */
  putIntegrationsById(id: string, body: Integration, query?: Record<string, string | number | undefined>): Promise<IntegrationView> {
    return this.request('PUT', `/api/v1/integrations/${encodeURIComponent(id)}`, { query, body });
  }

  /** POST /api/v1/integrations/{id}/sync */
  postIntegrationsSyncById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/integrations/${encodeURIComponent(id)}/sync`, { query });
  }

  /** GET /api/v1/integrations/{id}/syncs */
  getIntegrationsSyncsById(id: string, query?: Record<string, string | number | undefined>): Promise<Array<SyncRun>> {
    return this.request('GET', `/api/v1/integrations/${encodeURIComponent(id)}/syncs`, { query });
  }

  /** POST /api/v1/integrations/{id}/test */
  postIntegrationsTestById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/integrations/${encodeURIComponent(id)}/test`, { query });
  }

  /** POST /api/v1/mappings/preview */
  postMappingsPreview(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/mappings/preview`, { query });
  }

  /** GET /api/v1/runs */
  getRuns(query?: Record<string, string | number | undefined>): Promise<RunPage> {
    return this.request('GET', `/api/v1/runs`, { query });
  }

  /** GET /api/v1/runs/{id} */
  getRunsById(id: string, query?: Record<string, string | number | undefined>): Promise<Run> {
    return this.request('GET', `/api/v1/runs/${encodeURIComponent(id)}`, { query });
  }

  /** PATCH /api/v1/runs/{id} */
  patchRunsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PATCH', `/api/v1/runs/${encodeURIComponent(id)}`, { query });
  }

  /** POST /api/v1/runs/{id}/approve */
  postRunsApproveById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/approve`, { query });
  }

  /** POST /api/v1/runs/{id}/cancel */
  postRunsCancelById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/cancel`, { query });
  }

  /** POST /api/v1/runs/{id}/logs */
  postRunsLogsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/logs`, { query });
  }

  /** POST /api/v1/runs/{id}/reject */
  postRunsRejectById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/reject`, { query });
  }

  /** PATCH /api/v1/runs/{id}/steps/{step} */
  patchRunsStepsByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PATCH', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/approve */
  postRunsStepsApproveByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/approve`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/logs */
  postRunsStepsLogsByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/logs`, { query });
  }

  /** POST /api/v1/runs/{id}/steps/{step}/reject */
  postRunsStepsRejectByIdStep(id: string, step: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/runs/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/reject`, { query });
  }

  /** GET /api/v1/secrets */
  getSecrets(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/secrets`, { query });
  }

  /** DELETE /api/v1/secrets/{id} */
  deleteSecretsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/secrets/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/secrets/{id} */
  putSecretsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PUT', `/api/v1/secrets/${encodeURIComponent(id)}`, { query });
  }

  /** POST /api/v1/service-accounts */
  postServiceAccounts(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/service-accounts`, { query });
  }

  /** GET /api/v1/teams */
  getTeams(query?: Record<string, string | number | undefined>): Promise<Array<Team>> {
    return this.request('GET', `/api/v1/teams`, { query });
  }

  /** DELETE /api/v1/teams/{id} */
  deleteTeamsById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/teams/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/teams/{id} */
  putTeamsById(id: string, body: Team, query?: Record<string, string | number | undefined>): Promise<Team> {
    return this.request('PUT', `/api/v1/teams/${encodeURIComponent(id)}`, { query, body });
  }

  /** GET /api/v1/tokens */
  getTokens(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/tokens`, { query });
  }

  /** POST /api/v1/tokens */
  postTokens(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('POST', `/api/v1/tokens`, { query });
  }

  /** DELETE /api/v1/tokens/{id} */
  deleteTokensById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/tokens/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/users */
  getUsers(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/users`, { query });
  }

  /** PATCH /api/v1/users/{id} */
  patchUsersById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('PATCH', `/api/v1/users/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/users/lookup */
  getUsersLookup(query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/users/lookup`, { query });
  }

  /** GET /api/v1/webhooks */
  getWebhooks(query?: Record<string, string | number | undefined>): Promise<Array<WebhookView>> {
    return this.request('GET', `/api/v1/webhooks`, { query });
  }

  /** DELETE /api/v1/webhooks/{id} */
  deleteWebhooksById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('DELETE', `/api/v1/webhooks/${encodeURIComponent(id)}`, { query });
  }

  /** GET /api/v1/webhooks/{id} */
  getWebhooksById(id: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', `/api/v1/webhooks/${encodeURIComponent(id)}`, { query });
  }

  /** PUT /api/v1/webhooks/{id} */
  putWebhooksById(id: string, body: Webhook, query?: Record<string, string | number | undefined>): Promise<WebhookView> {
    return this.request('PUT', `/api/v1/webhooks/${encodeURIComponent(id)}`, { query, body });
  }

  /** GET /api/v1/webhooks/{id}/deliveries */
  getWebhooksDeliveriesById(id: string, query?: Record<string, string | number | undefined>): Promise<Array<Delivery>> {
    return this.request('GET', `/api/v1/webhooks/${encodeURIComponent(id)}/deliveries`, { query });
  }
}
