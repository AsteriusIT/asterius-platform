import { validateAuth } from '../../lib/auth.js';
import { str } from '../../actions/types.js';
import type { Source } from '../types.js';
import { httpSource } from './http.js';

/**
 * Tool connectors as presets over the http source: a preset lists, per kind, the path, how to find the items and how
 * to page. Authentication and retries come from the shared HTTP layer. Add a connector by adding an entry to `PRESETS`.
 *
 * Path and query templates use `{name}` (required config key, URL-encoded) and `{name|default}`.
 */

interface PresetKind {
  path: string;
  query?: Record<string, string>;
  /** JSONata selecting the items of a response. */
  itemsPath?: string;
  pagination?: Record<string, unknown>;
}

interface Preset {
  type: string;
  title: string;
  description: string;
  /** Config keys that must be set. */
  required: string[];
  /** Default `baseUrl` (SaaS endpoint), when there is one. */
  baseUrl?: string;
  headers(c: Record<string, unknown>): Record<string, string>;
  kinds: Record<string, PresetKind>;
  example: Record<string, unknown>;
}

const bearer = (c: Record<string, unknown>) => ({ authorization: `Bearer ${str(c.token)}` });
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

export const PRESETS: Preset[] = [
  {
    type: 'argocd',
    title: 'Argo CD',
    description: 'Applications and projects of an Argo CD server.',
    required: ['baseUrl', 'token'],
    headers: bearer,
    kinds: { application: { path: '/api/v1/applications', itemsPath: 'items' }, project: { path: '/api/v1/projects', itemsPath: 'items' } },
    example: {
      type: 'argocd',
      config: { baseUrl: 'https://argocd.example.com', token: '${secret:ARGOCD_TOKEN}' },
      mappings: [
        {
          kind: 'application',
          entity: {
            blueprint: 'deployment',
            identifier: 'metadata.name',
            properties: {
              health: 'status.health.status',
              sync: 'status.sync.status',
              repo: 'spec.source.repoURL',
              namespace: 'spec.destination.namespace',
              // DORA insights: finish time of the last sync operation and its phase (Succeeded / Failed).
              deployedAt: 'status.operationState.finishedAt',
              status: 'status.operationState.phase',
            },
          },
        },
      ],
    },
  },
  {
    type: 'pagerduty',
    title: 'PagerDuty',
    description: 'Services, teams and current on-calls.',
    required: ['token'],
    baseUrl: 'https://api.pagerduty.com',
    headers: (c) => ({ authorization: `Token token=${str(c.token)}`, accept: 'application/vnd.pagerduty+json;version=2' }),
    kinds: {
      service: { path: '/services', query: { limit: '100' }, itemsPath: 'services', pagination: { type: 'offset', param: 'offset', pageSize: 100 } },
      team: { path: '/teams', query: { limit: '100' }, itemsPath: 'teams', pagination: { type: 'offset', param: 'offset', pageSize: 100 } },
      incident: {
        path: '/incidents',
        query: { limit: '100', 'statuses[]': 'resolved' },
        itemsPath: 'incidents',
        pagination: { type: 'offset', param: 'offset', pageSize: 100 },
      },
      oncall: { path: '/oncalls', query: { limit: '100' }, itemsPath: 'oncalls', pagination: { type: 'offset', param: 'offset', pageSize: 100 } },
    },
    example: {
      type: 'pagerduty',
      config: { token: '${secret:PAGERDUTY_TOKEN}' },
      mappings: [
        { kind: 'service', entity: { blueprint: 'service', identifier: '$lowercase(name)', properties: { pagerdutyUrl: 'html_url', status: 'status' } } },
        // DORA insights (MTTR): incident created / resolved times.
        {
          kind: 'incident',
          entity: {
            blueprint: 'incident',
            identifier: "incident_number & ''",
            title: 'title',
            properties: { createdAt: 'created_at', resolvedAt: 'resolved_at', status: 'status', url: 'html_url' },
          },
        },
      ],
    },
  },
  {
    type: 'opsgenie',
    title: 'Opsgenie',
    description: 'Teams and services.',
    required: ['token'],
    baseUrl: 'https://api.opsgenie.com',
    headers: (c) => ({ authorization: `GenieKey ${str(c.token)}` }),
    kinds: {
      team: { path: '/v2/teams', itemsPath: 'data' },
      service: { path: '/v1/services', itemsPath: 'data', pagination: { type: 'offset', param: 'offset', pageSize: 100 } },
    },
    example: { type: 'opsgenie', config: { token: '${secret:OPSGENIE_KEY}' }, mappings: [{ kind: 'team', entity: { blueprint: 'team', identifier: 'name' } }] },
  },
  {
    type: 'jira',
    title: 'Jira Cloud',
    description: 'Projects and issues (JQL).',
    required: ['baseUrl', 'email', 'token'],
    headers: (c) => ({ authorization: basic(str(c.email), str(c.token)) }),
    kinds: {
      project: {
        path: '/rest/api/3/project/search',
        query: { maxResults: '50' },
        itemsPath: 'values',
        pagination: { type: 'offset', param: 'startAt', pageSize: 50, totalPath: 'total' },
      },
      issue: {
        path: '/rest/api/3/search/jql',
        query: { jql: '{jql|updated >= -30d ORDER BY updated DESC}', maxResults: '100', fields: '*all' },
        itemsPath: 'issues',
        pagination: { type: 'cursor', param: 'nextPageToken', cursorPath: 'nextPageToken' },
      },
    },
    example: {
      type: 'jira',
      config: { baseUrl: 'https://acme.atlassian.net', email: 'bot@acme.com', token: '${secret:JIRA_TOKEN}', jql: 'project = PLAT AND statusCategory != Done' },
      mappings: [{ kind: 'issue', entity: { blueprint: 'ticket', identifier: 'key', title: 'fields.summary', properties: { status: 'fields.status.name' } } }],
    },
  },
  {
    type: 'sonarqube',
    title: 'SonarQube',
    description: 'Projects and quality gates.',
    required: ['baseUrl', 'token'],
    headers: (c) => ({ authorization: basic(str(c.token), '') }),
    kinds: {
      project: {
        path: '/api/components/search',
        query: { qualifiers: 'TRK', ps: '500' },
        itemsPath: 'components',
        pagination: { type: 'page', param: 'p', pageSize: 500, totalPath: 'paging.total' },
      },
      'quality-gate': { path: '/api/qualitygates/list', itemsPath: 'qualitygates' },
    },
    example: {
      type: 'sonarqube',
      config: { baseUrl: 'https://sonar.example.com', token: '${secret:SONAR_TOKEN}' },
      mappings: [{ kind: 'project', entity: { blueprint: 'code-quality', identifier: 'key', title: 'name' } }],
    },
  },
  {
    type: 'nexus',
    title: 'Sonatype Nexus Repository',
    description: 'Repositories and components (every repository, or the one of `repository`).',
    required: ['baseUrl', 'user', 'password'],
    headers: (c) => ({ authorization: basic(str(c.user), str(c.password)) }),
    kinds: {
      repository: { path: '/service/rest/v1/repositories' },
      component: {
        path: '/service/rest/v1/search',
        query: { repository: '{repository|}' },
        itemsPath: 'items',
        pagination: { type: 'cursor', param: 'continuationToken', cursorPath: 'continuationToken' },
      },
    },
    example: {
      type: 'nexus',
      config: { baseUrl: 'https://nexus.example.com', user: 'asterius-platform', password: '${secret:NEXUS_PASSWORD}' },
      mappings: [{ kind: 'repository', entity: { blueprint: 'artifact-repository', identifier: 'name', properties: { format: 'format', url: 'url' } } }],
    },
  },
  {
    type: 'snyk',
    title: 'Snyk',
    description: 'Projects of an organization.',
    required: ['orgId', 'token'],
    baseUrl: 'https://api.snyk.io',
    headers: (c) => ({ authorization: `token ${str(c.token)}`, accept: 'application/vnd.api+json' }),
    kinds: {
      project: {
        path: '/rest/orgs/{orgId}/projects',
        query: { version: '2024-06-21', limit: '100' },
        itemsPath: 'data',
        pagination: { type: 'next', nextUrl: 'links.next' },
      },
      issue: {
        path: '/rest/orgs/{orgId}/issues',
        query: { version: '2024-06-21', limit: '100' },
        itemsPath: 'data',
        pagination: { type: 'next', nextUrl: 'links.next' },
      },
    },
    example: {
      type: 'snyk',
      config: { orgId: '00000000-0000-0000-0000-000000000000', token: '${secret:SNYK_TOKEN}' },
      mappings: [{ kind: 'project', entity: { blueprint: 'security-project', identifier: 'id', title: 'attributes.name' } }],
    },
  },
  {
    type: 'terraform-cloud-workspaces',
    title: 'Terraform Cloud workspaces',
    description: 'Workspaces and projects of an organization.',
    required: ['organization', 'token'],
    baseUrl: 'https://app.terraform.io',
    headers: (c) => ({ ...bearer(c), accept: 'application/vnd.api+json' }),
    kinds: {
      workspace: {
        path: '/api/v2/organizations/{organization}/workspaces',
        query: { 'page[size]': '100' },
        itemsPath: 'data',
        pagination: { type: 'page', param: 'page[number]', pageSize: 100, startAt: 1 },
      },
      project: {
        path: '/api/v2/organizations/{organization}/projects',
        query: { 'page[size]': '100' },
        itemsPath: 'data',
        pagination: { type: 'page', param: 'page[number]', pageSize: 100, startAt: 1 },
      },
    },
    example: {
      type: 'terraform-cloud-workspaces',
      config: { organization: 'acme', token: '${secret:TFC_TOKEN}' },
      mappings: [
        {
          kind: 'workspace',
          entity: { blueprint: 'workspace', identifier: 'attributes.name', properties: { terraformVersion: 'attributes."terraform-version"' } },
        },
      ],
    },
  },
  {
    type: 'okta',
    title: 'Okta directory',
    description: 'Users and groups.',
    required: ['baseUrl', 'token'],
    headers: (c) => ({ authorization: `SSWS ${str(c.token)}` }),
    kinds: {
      user: { path: '/api/v1/users', query: { limit: '200' }, pagination: { type: 'link' } },
      group: { path: '/api/v1/groups', query: { limit: '200' }, pagination: { type: 'link' } },
    },
    example: {
      type: 'okta',
      config: { baseUrl: 'https://acme.okta.com', token: '${secret:OKTA_TOKEN}' },
      mappings: [{ kind: 'user', entity: { blueprint: 'person', identifier: 'profile.email', title: 'profile.displayName' } }],
    },
  },
  {
    type: 'entra-directory',
    title: 'Microsoft Entra directory',
    description: 'Users and groups through Microsoft Graph (use an `auth` block for client credentials or workload identity).',
    required: [],
    baseUrl: 'https://graph.microsoft.com',
    headers: (c) => (c.token ? bearer(c) : {}),
    kinds: {
      user: { path: '/v1.0/users', query: { $top: '999' }, itemsPath: 'value', pagination: { type: 'next', nextUrl: '`@odata.nextLink`' } },
      group: { path: '/v1.0/groups', query: { $top: '999' }, itemsPath: 'value', pagination: { type: 'next', nextUrl: '`@odata.nextLink`' } },
    },
    example: {
      type: 'entra-directory',
      config: {
        auth: {
          type: 'oauth2-client-credentials',
          tokenUrl: 'https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token',
          clientId: '<app id>',
          clientSecret: '${secret:ENTRA_SECRET}',
          scope: 'https://graph.microsoft.com/.default',
        },
      },
      mappings: [{ kind: 'user', entity: { blueprint: 'person', identifier: 'mail', title: 'displayName' } }],
    },
  },
  {
    type: 'grafana',
    title: 'Grafana',
    description: 'Dashboards and folders.',
    required: ['baseUrl', 'token'],
    headers: bearer,
    kinds: {
      dashboard: { path: '/api/search', query: { type: 'dash-db', limit: '5000' } },
      folder: { path: '/api/folders', query: { limit: '1000' } },
    },
    example: {
      type: 'grafana',
      config: { baseUrl: 'https://grafana.example.com', token: '${secret:GRAFANA_TOKEN}' },
      mappings: [{ kind: 'dashboard', entity: { blueprint: 'dashboard', identifier: 'uid', title: 'title', properties: { url: 'url' } } }],
    },
  },
  {
    type: 'datadog',
    title: 'Datadog',
    description: 'Monitors and service definitions.',
    required: ['apiKey', 'appKey'],
    baseUrl: 'https://api.datadoghq.com',
    headers: (c) => ({ 'dd-api-key': str(c.apiKey), 'dd-application-key': str(c.appKey) }),
    kinds: {
      monitor: { path: '/api/v1/monitor', query: { page_size: '100', page: '0' }, pagination: { type: 'page', param: 'page', pageSize: 100, startAt: 0 } },
      service: { path: '/api/v2/services/definitions', query: { 'page[size]': '100' }, itemsPath: 'data' },
    },
    example: {
      type: 'datadog',
      config: { baseUrl: 'https://api.datadoghq.eu', apiKey: '${secret:DD_API_KEY}', appKey: '${secret:DD_APP_KEY}' },
      mappings: [{ kind: 'monitor', entity: { blueprint: 'monitor', identifier: '$string(id)', title: 'name', properties: { status: 'overall_state' } } }],
    },
  },
  {
    type: 'servicenow',
    title: 'ServiceNow',
    description: 'Business services and configuration items from the table API.',
    required: ['baseUrl', 'user', 'password'],
    headers: (c) => ({ authorization: basic(str(c.user), str(c.password)) }),
    kinds: {
      service: {
        path: '/api/now/table/cmdb_ci_service',
        query: { sysparm_limit: '1000' },
        itemsPath: 'result',
        pagination: { type: 'offset', param: 'sysparm_offset', pageSize: 1000 },
      },
      'ci-server': {
        path: '/api/now/table/cmdb_ci_server',
        query: { sysparm_limit: '1000' },
        itemsPath: 'result',
        pagination: { type: 'offset', param: 'sysparm_offset', pageSize: 1000 },
      },
    },
    example: {
      type: 'servicenow',
      config: { baseUrl: 'https://acme.service-now.com', user: 'asterius', password: '${secret:SNOW_PASSWORD}' },
      mappings: [{ kind: 'service', entity: { blueprint: 'service', identifier: 'name', properties: { criticality: 'busines_criticality' } } }],
    },
  },
];

/** Resolve `{name}` / `{name|default}` placeholders against the configuration. Exported for tests. */
export function fill(template: string, config: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z0-9_]+)(?:\|([^}]*))?\}/g, (_m, name: string, dflt: string | undefined) => {
    const v = config[name];
    if (v === undefined || v === null || v === '') {
      if (dflt !== undefined) return dflt;
      throw new Error(`missing configuration "${name}"`);
    }
    return str(v);
  });
}

export function buildRequest(preset: Preset, kind: string, config: Record<string, unknown>) {
  const k = preset.kinds[kind];
  if (!k) throw new Error(`${preset.type}: unknown kind "${kind}" (available: ${Object.keys(preset.kinds).join(', ')})`);
  const base = str(config.baseUrl || preset.baseUrl).replace(/\/$/, '');
  const url = new URL(`${base}${fill(k.path, Object.fromEntries(Object.entries(config).map(([n, v]) => [n, encodeURIComponent(str(v))])))}`);
  // A parameter whose template resolves to nothing (`{repository|}` unset) is left out rather than sent empty.
  for (const [name, value] of Object.entries(k.query ?? {})) {
    const v = fill(value, config);
    if (v !== '') url.searchParams.set(name, v);
  }
  return {
    url: url.toString(),
    headers: { ...preset.headers(config), ...((config.headers as Record<string, string>) ?? {}) },
    itemsPath: k.itemsPath,
    pagination: k.pagination,
    auth: config.auth,
  };
}

export function presetSource(preset: Preset): Source {
  return {
    info: { type: preset.type, title: preset.title, description: preset.description, kinds: Object.keys(preset.kinds), example: preset.example },
    incremental: false,
    validate(c) {
      const credentials = ['token', 'email', 'user', 'password', 'apiKey', 'appKey']; // replaced by an `auth` block
      const missing = preset.required.filter((f) => !(c.auth && credentials.includes(f)) && (c[f] === undefined || c[f] === ''));
      if (!preset.baseUrl && !c.baseUrl && !missing.includes('baseUrl')) missing.unshift('baseUrl');
      if (missing.length) throw new Error(`${preset.type}: missing ${missing.join(', ')}`);
      validateAuth(c.auth);
    },
    list(kind, env) {
      const r = buildRequest(preset, kind, env.config);
      return httpSource.list!(kind, { ...env, config: { url: r.url, headers: r.headers, itemsPath: r.itemsPath, pagination: r.pagination, auth: r.auth } });
    },
  };
}

export const presetSources: Source[] = PRESETS.map(presetSource);
