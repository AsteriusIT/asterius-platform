import fs from 'node:fs';
import path from 'node:path';
import { API_URL, SEED_FILE } from './env';

/**
 * Deterministic data for the end-to-end tests, created through the public API only: an admin, two members, one
 * organization, teams, blueprints and entities, workflows (one fragment) and runs in every interesting state.
 * Everything is created in sequence, each run waited for, so lists come back in the same order every time.
 */

export const PASSWORD = 'correct-horse-battery';
export const ORG = 'acme';

export interface SeedState {
  org: string;
  /** Session tokens. `admin` is the first account (platform super-admin, admin of the organization). */
  tokens: { admin: string; member: string };
  /** Run ids by role in the screenshots. */
  runs: { waitingStep: string; pendingRequest: string; failed: string; succeeded: string; rejected: string; cancelled: string };
}

type Json = Record<string, unknown>;

async function call<T = Json>(method: string, url: string, token?: string, body?: unknown, org: string | null = ORG): Promise<T> {
  const res = await fetch(API_URL + url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(token && org ? { 'x-asterius-org': org } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`seed: ${method} ${url} → ${res.status} ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RunView {
  id: string;
  status: string;
  steps?: { id: string; status: string }[];
}

/** Poll a run until `done` holds (the worker picks runs up asynchronously). */
async function runUntil(token: string, id: string, done: (r: RunView) => boolean, what: string): Promise<RunView> {
  const end = Date.now() + 60_000;
  for (;;) {
    const r = await call<RunView>('GET', `/api/v1/runs/${id}`, token);
    if (done(r)) return r;
    if (Date.now() > end) throw new Error(`seed: run ${id} never reached "${what}" (status ${r.status})`);
    await pause(150);
  }
}
const status =
  (...wanted: string[]) =>
  (r: RunView) =>
    wanted.includes(r.status);
const stepWaiting = (step: string) => (r: RunView) => !!r.steps?.some((s) => s.id === step && /WAIT|PENDING_APPROVAL|APPROVAL/.test(s.status));

// ---------------------------------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------------------------------

const teams = [
  { identifier: 'platform', title: 'Platform', description: 'Builds and runs the internal developer platform.' },
  { identifier: 'payments', title: 'Payments', description: 'Payment processing and billing.' },
  { identifier: 'checkout', title: 'Checkout', description: 'Cart, checkout and order flows.' },
];

const blueprints = [
  {
    identifier: 'system',
    title: 'System',
    icon: 'sitemap',
    description: 'A group of services delivering one business capability.',
    schema: {
      properties: {
        criticality: {
          type: 'string',
          title: 'Criticality',
          enum: ['low', 'medium', 'high', 'critical'],
          enumColors: { low: 'gray', medium: 'blue', high: 'orange', critical: 'red' },
        },
        description: { type: 'string', title: 'Description', format: 'markdown' },
      },
      required: ['criticality'],
    },
  },
  {
    identifier: 'service',
    title: 'Service',
    icon: 'box',
    description: 'A deployable unit owned by one team.',
    schema: {
      properties: {
        language: { type: 'string', title: 'Language', enum: ['go', 'java', 'node', 'python', 'dotnet'] },
        tier: { type: 'integer', title: 'Tier', minimum: 1, maximum: 3, default: 2 },
        lifecycle: {
          type: 'string',
          title: 'Lifecycle',
          enum: ['experimental', 'production', 'deprecated'],
          default: 'experimental',
          enumColors: { experimental: 'yellow', production: 'green', deprecated: 'gray' },
        },
        repositoryUrl: { type: 'string', title: 'Repository', format: 'url' },
        // Left empty on every entity: the Docs tab would fetch the file (no network in the tests).
        docs: { type: 'string', title: 'Documentation', format: 'docs', description: 'URL of a markdown file, shown in the Docs tab' },
        onCall: { type: 'string', title: 'On-call', format: 'email' },
        version: { type: 'string', title: 'Version' },
      },
      order: ['lifecycle', 'tier', 'language', 'version', 'repositoryUrl', 'docs', 'onCall'],
    },
    relations: {
      system: { title: 'System', target: 'system' },
      dependsOn: { title: 'Depends on', target: 'service', many: true },
    },
  },
  {
    identifier: 'environment',
    title: 'Environment',
    icon: 'server',
    description: 'Runtime environments (requested through self-service).',
    schema: {
      properties: {
        type: {
          type: 'string',
          title: 'Type',
          enum: ['development', 'staging', 'production'],
          enumColors: { development: 'gray', staging: 'blue', production: 'red' },
        },
        region: { type: 'string', title: 'Region', enum: ['westeurope', 'northeurope', 'switzerlandnorth'] },
      },
      required: ['type'],
    },
  },
];

interface SeedEntity {
  blueprint: string;
  identifier: string;
  title: string;
  team?: string;
  properties: Json;
  relations?: Json;
}
const svc = (
  identifier: string,
  title: string,
  team: string,
  system: string,
  p: { language: string; tier: number; lifecycle: string; version: string },
  dependsOn: string[] = [],
): SeedEntity => ({
  blueprint: 'service',
  identifier,
  title,
  team,
  properties: { ...p, repositoryUrl: `https://github.com/acme/${identifier}`, onCall: `${team}-oncall@acme.example` },
  relations: { system, dependsOn },
});

const entities: SeedEntity[] = [
  {
    blueprint: 'system',
    identifier: 'payments',
    title: 'Payments',
    team: 'payments',
    properties: { criticality: 'critical', description: 'Card payments, refunds and **billing**.' },
  },
  {
    blueprint: 'system',
    identifier: 'storefront',
    title: 'Storefront',
    team: 'checkout',
    properties: { criticality: 'high', description: 'Browse, cart and checkout.' },
  },
  {
    blueprint: 'system',
    identifier: 'developer-platform',
    title: 'Developer platform',
    team: 'platform',
    properties: { criticality: 'medium', description: 'Tooling for engineering teams.' },
  },
  svc('ledger', 'Ledger', 'payments', 'payments', { language: 'java', tier: 1, lifecycle: 'production', version: '4.12.0' }),
  svc('payments-api', 'Payments API', 'payments', 'payments', { language: 'go', tier: 1, lifecycle: 'production', version: '2.8.1' }, ['ledger']),
  svc('fraud-scoring', 'Fraud scoring', 'payments', 'payments', { language: 'python', tier: 2, lifecycle: 'experimental', version: '0.9.3' }, ['payments-api']),
  svc('checkout-web', 'Checkout web', 'checkout', 'storefront', { language: 'node', tier: 1, lifecycle: 'production', version: '7.3.0' }, [
    'payments-api',
    'cart-service',
  ]),
  svc('cart-service', 'Cart service', 'checkout', 'storefront', { language: 'go', tier: 2, lifecycle: 'production', version: '1.14.2' }),
  svc('search-api', 'Search API', 'checkout', 'storefront', { language: 'dotnet', tier: 3, lifecycle: 'deprecated', version: '3.0.5' }),
  svc('portal', 'Developer portal', 'platform', 'developer-platform', { language: 'node', tier: 2, lifecycle: 'production', version: '0.1.0' }),
  svc('ci-runners', 'CI runners', 'platform', 'developer-platform', { language: 'go', tier: 2, lifecycle: 'experimental', version: '0.4.0' }),
  { blueprint: 'environment', identifier: 'dev-eu', title: 'Development EU', team: 'platform', properties: { type: 'development', region: 'westeurope' } },
  { blueprint: 'environment', identifier: 'staging-eu', title: 'Staging EU', team: 'platform', properties: { type: 'staging', region: 'westeurope' } },
  { blueprint: 'environment', identifier: 'prod-eu', title: 'Production EU', team: 'platform', properties: { type: 'production', region: 'northeurope' } },
  { blueprint: 'environment', identifier: 'prod-ch', title: 'Production CH', team: 'platform', properties: { type: 'production', region: 'switzerlandnorth' } },
];

const fragments = [
  {
    identifier: 'platform-approval',
    title: 'Wait for platform approval',
    description: 'Asks the platform team and waits for the decision. Outputs whether it was approved and by whom.',
    params: {
      properties: {
        summary: { type: 'string', title: 'What is requested (Markdown)' },
        review: { type: 'string', title: 'Review notes', default: '' },
      },
      required: ['summary'],
    },
    steps: [
      {
        id: 'approve',
        name: 'Platform approval',
        type: 'approval',
        approvers: { teams: ['platform'], roles: ['admin'] },
        message: '{{ params.summary }}\n\nReview: **{{ params.review }}**',
      },
      { id: 'record', name: 'Record the decision', type: 'transform', output: { approvedBy: 'steps.approve.output.by' } },
    ],
    outputs: { approved: 'steps.approve.output.approved', approvedBy: 'steps.record.output.approvedBy' },
  },
];

const actions = [
  {
    identifier: 'register-service',
    title: 'Register a service',
    icon: 'plus',
    description: 'Add an existing service to the catalog.',
    trigger: {
      type: 'form',
      on: 'create',
      blueprint: 'service',
      inputs: {
        properties: {
          name: { type: 'string', title: 'Name', pattern: '^[a-z][a-z0-9-]{2,40}$', description: 'lowercase, digits and dashes' },
          team: { type: 'string', title: 'Owning team', format: 'team' },
          system: { type: 'string', title: 'System', format: 'entity', blueprint: 'system' },
          language: { type: 'string', title: 'Language', enum: ['go', 'java', 'node', 'python', 'dotnet'] },
          repositoryUrl: { type: 'string', title: 'Repository URL', format: 'url' },
        },
        required: ['name', 'team', 'system', 'language'],
        order: ['name', 'team', 'system', 'language', 'repositoryUrl'],
      },
    },
    steps: [
      {
        id: 'run',
        name: 'Register a service',
        type: 'invoke',
        invoker: {
          type: 'catalog',
          operation: 'upsert',
          blueprint: 'service',
          identifier: '{{ inputs.name }}',
          team: '{{ inputs.team }}',
          properties: { language: '{{ inputs.language }}', repositoryUrl: '{{ inputs.repositoryUrl }}' },
          relations: { system: '{{ inputs.system }}' },
        },
      },
    ],
  },
  {
    identifier: 'request-environment',
    title: 'Request an environment',
    icon: 'server',
    description: 'Request a new environment. Requests are approved by the platform team before anything is created.',
    trigger: {
      type: 'form',
      on: 'create',
      blueprint: 'environment',
      inputs: {
        properties: {
          name: { type: 'string', title: 'Name', pattern: '^[a-z][a-z0-9-]{2,30}$' },
          type: { type: 'string', title: 'Type', enum: ['development', 'staging', 'production'], default: 'development' },
          region: { type: 'string', title: 'Region', enum: ['westeurope', 'northeurope', 'switzerlandnorth'], default: 'westeurope' },
          justification: { type: 'string', title: 'Justification', format: 'markdown' },
        },
        required: ['name', 'type', 'justification'],
      },
      approval: { required: true, approvers: { teams: ['platform'], roles: ['admin'] }, minApprovals: 1 },
    },
    steps: [
      {
        id: 'run',
        name: 'Create the environment',
        type: 'invoke',
        invoker: {
          type: 'catalog',
          operation: 'upsert',
          blueprint: 'environment',
          identifier: '{{ inputs.name }}',
          team: 'platform',
          properties: { type: '{{ inputs.type }}', region: '{{ inputs.region }}' },
        },
      },
    ],
  },
  {
    identifier: 'request-access',
    title: 'Request access',
    icon: 'key',
    description: 'Ask for access to a production system. The owning team answers within one business day.',
    trigger: {
      type: 'form',
      on: 'create',
      inputs: {
        properties: {
          system: { type: 'string', title: 'System', format: 'entity', blueprint: 'system' },
          level: { type: 'string', title: 'Access level', enum: ['read', 'write', 'admin'], default: 'read' },
          until: { type: 'string', title: 'Until', format: 'date' },
          reason: { type: 'string', title: 'Reason', format: 'markdown' },
        },
        required: ['system', 'level', 'reason'],
      },
      approval: { required: true, approvers: { roles: ['admin'] }, minApprovals: 1 },
    },
    steps: [{ id: 'grant', name: 'Record the grant', type: 'transform', output: { system: 'inputs.system', level: 'inputs.level' } }],
  },
  {
    identifier: 'report-incident',
    title: 'Report an incident',
    icon: 'alert-triangle',
    description: 'Open an incident, page the on-call engineer and start the timeline.',
    trigger: {
      type: 'form',
      on: 'create',
      inputs: {
        properties: {
          title: { type: 'string', title: 'What is happening?' },
          severity: { type: 'string', title: 'Severity', enum: ['sev1', 'sev2', 'sev3'], default: 'sev3' },
          service: { type: 'string', title: 'Affected service', format: 'entity', blueprint: 'service' },
        },
        required: ['title', 'severity'],
      },
    },
    steps: [{ id: 'open', name: 'Open the incident', type: 'transform', output: { title: 'inputs.title', severity: 'inputs.severity' } }],
  },
  {
    identifier: 'deploy-service',
    title: 'Deploy to production',
    icon: 'rocket',
    description: 'Ship a version of the service to production. The platform team approves each production deployment.',
    trigger: {
      type: 'form',
      on: 'day-2',
      blueprint: 'service',
      inputs: {
        properties: {
          version: { type: 'string', title: 'Version', pattern: '^\\d+\\.\\d+\\.\\d+$', description: 'Semantic version to deploy' },
          environment: { type: 'string', title: 'Environment', format: 'entity', blueprint: 'environment' },
          notes: { type: 'string', title: 'Release notes', format: 'markdown' },
        },
        required: ['version', 'environment'],
        order: ['version', 'environment', 'notes'],
      },
    },
    steps: [
      {
        id: 'plan',
        name: 'Plan the rollout',
        type: 'transform',
        output: { target: 'inputs.environment', version: 'inputs.version', strategy: '"canary"' },
      },
      {
        id: 'approval',
        name: 'Platform approval',
        type: 'fragment',
        fragment: 'platform-approval',
        with: {
          summary: 'Deploy **{{ entity.title }} {{ inputs.version }}** to `{{ inputs.environment }}`',
          review: 'canary rollout, automatic rollback on errors',
        },
      },
      {
        id: 'deploy',
        name: 'Record the deployment',
        type: 'invoke',
        invoker: {
          type: 'catalog',
          operation: 'upsert',
          merge: true,
          blueprint: 'service',
          identifier: '{{ entity.identifier }}',
          properties: { version: '{{ inputs.version }}' },
        },
      },
    ],
  },
  {
    identifier: 'archive-service',
    title: 'Archive a service',
    icon: 'archive',
    description: 'Mark the service as deprecated and move it to the archive.',
    trigger: {
      type: 'form',
      on: 'day-2',
      blueprint: 'service',
      inputs: { properties: { reason: { type: 'string', title: 'Reason' } }, required: ['reason'] },
    },
    steps: [
      {
        id: 'deprecate',
        name: 'Mark as deprecated',
        type: 'invoke',
        invoker: {
          type: 'catalog',
          operation: 'upsert',
          merge: true,
          blueprint: 'service',
          identifier: '{{ entity.identifier }}',
          properties: { lifecycle: 'deprecated' },
        },
      },
      {
        // The `archive` blueprint does not exist: this step always fails (red log lines on the run page).
        id: 'archive',
        name: 'Move to the archive',
        type: 'invoke',
        invoker: {
          type: 'catalog',
          operation: 'upsert',
          blueprint: 'archive',
          identifier: '{{ entity.identifier }}',
          properties: { reason: '{{ inputs.reason }}' },
        },
      },
      { id: 'notify', name: 'Summarise', type: 'transform', output: { archived: 'entity.identifier' } },
    ],
  },
];

// ---------------------------------------------------------------------------------------------------------------------

// ---- connectors and connections (Admin → Connections / Connectors) ----

/** The organization's own connector: an in-house CMDB. */
const connectorDefs = [
  {
    identifier: 'acme-cmdb',
    title: 'Acme CMDB',
    description: 'The in-house configuration database: applications, servers and change tickets.',
    icon: 'database',
    category: 'internal',
    fields: {
      properties: {
        tenant: { type: 'string', title: 'Tenant', description: 'Tenant code in the CMDB' },
        baseUrl: { type: 'string', title: 'API URL', format: 'url', default: 'https://cmdb.acme.example/api' },
      },
      required: ['tenant'],
      order: ['tenant', 'baseUrl'],
    },
    auth: [
      { type: 'bearer', title: 'API token', description: 'A token of a CMDB service account.' },
      {
        type: 'oauth2-client-credentials',
        title: 'Entra application',
        set: { tokenUrl: 'https://login.microsoftonline.com/acme/oauth2/v2.0/token', scope: 'api://cmdb/.default' },
      },
    ],
    test: { path: '/{{ connection.tenant }}/health' },
    kinds: {
      application: {
        title: 'Applications',
        path: '/{{ connection.tenant }}/applications',
        itemsPath: 'items',
        pagination: { type: 'page', param: 'page', pageSize: 100 },
      },
      server: { title: 'Servers', path: '/{{ connection.tenant }}/servers', itemsPath: 'items', since: { param: 'changedSince' } },
    },
    operations: {
      'open-change': {
        title: 'Open a change ticket',
        description: 'Opens a standard change for a deployment.',
        method: 'POST',
        path: '/{{ connection.tenant }}/changes',
        inputs: {
          properties: {
            application: { type: 'string', title: 'Application' },
            summary: { type: 'string', title: 'Summary' },
            risk: { type: 'string', title: 'Risk', enum: ['low', 'medium', 'high'], default: 'low' },
          },
          required: ['application', 'summary'],
        },
        body: { application: '{{ inputs.application }}', summary: '{{ inputs.summary }}', risk: '{{ inputs.risk }}' },
        output: { ticket: 'body.id' },
      },
      'get-application': {
        title: 'Get an application',
        kind: 'application',
        path: '/{{ connection.tenant }}/applications/{{ inputs.id }}',
        inputs: { properties: { id: { type: 'string', title: 'Application ID' } }, required: ['id'] },
      },
    },
  },
];

const connections = [
  {
    identifier: 'cmdb-prod',
    title: 'CMDB production',
    description: 'The production tenant of the CMDB, used to ingest applications and to open change tickets on deployments.',
    connector: 'acme-cmdb',
    fields: { tenant: 'acme' },
    auth: { type: 'bearer', token: '${secret:CMDB_TOKEN}' },
    access: 'read-write',
    allowed: { teams: ['platform', 'payments'] },
    api: { methods: ['GET', 'POST'], paths: ['/acme/changes'] },
  },
  {
    identifier: 'github-acme',
    title: 'GitHub Acme',
    connector: 'github',
    fields: { organization: 'acme' },
    auth: { type: 'bearer', token: '${secret:GITHUB_TOKEN}' },
    access: 'read',
  },
  {
    identifier: 'pagerduty',
    title: 'PagerDuty',
    connector: 'pagerduty',
    auth: { type: 'header', token: '${secret:PAGERDUTY_TOKEN}' },
    access: 'read',
  },
];

/** Disabled: never synced (no network in the tests), but it uses `cmdb-prod` and feeds the service blueprint. */
const connectionIntegrations = [
  {
    identifier: 'cmdb-applications',
    title: 'CMDB applications',
    type: 'connector',
    enabled: false,
    intervalMinutes: 0,
    config: { connection: 'cmdb-prod' },
    mappings: [{ kind: 'application', entity: { blueprint: 'service', identifier: '$lowercase(code)', title: 'name', properties: { version: 'version' } } }],
  },
];

async function register(email: string, name: string): Promise<{ token: string; user: { id: string } }> {
  return call('POST', '/api/auth/register', undefined, { email, name, password: PASSWORD });
}

async function build(): Promise<SeedState> {
  // Accounts. The first one bootstraps the platform admin.
  const admin = await register('ada@acme.example', 'Ada Lovelace');
  const member = await register('grace@acme.example', 'Grace Hopper');
  const third = await register('alan@acme.example', 'Alan Turing');
  const a = admin.token;
  const m = member.token;

  await call('POST', '/api/orgs', a, { slug: ORG, name: 'Acme Corp' }, null);
  for (const email of ['grace@acme.example', 'alan@acme.example']) await call('POST', '/api/v1/org/members', a, { email, role: 'member' });
  // No onboarding tour over the pages.
  for (const t of [a, m, third.token]) await call('PUT', '/api/auth/me/tour', t, { completed: true });

  for (const t of teams) await call('PUT', `/api/v1/teams/${t.identifier}`, a, t);
  await call('PATCH', `/api/v1/users/${admin.user.id}`, a, { teams: ['platform'] });
  await call('PATCH', `/api/v1/users/${member.user.id}`, a, { teams: ['payments'] });
  await call('PATCH', `/api/v1/users/${third.user.id}`, a, { teams: ['checkout', 'payments'] });

  for (const b of blueprints) await call('PUT', `/api/v1/blueprints/${b.identifier}`, a, b);
  for (const { blueprint, ...e } of entities) await call('POST', `/api/v1/blueprints/${blueprint}/entities`, a, e);
  // A second and third version of one service, for its History tab.
  await call('PUT', '/api/v1/blueprints/service/entities/payments-api', a, {
    ...entities.find((e) => e.identifier === 'payments-api'),
    blueprint: undefined,
    properties: { ...entities.find((e) => e.identifier === 'payments-api')!.properties, version: '2.9.0' },
  });

  for (const f of fragments) await call('PUT', `/api/v1/fragments/${f.identifier}`, a, f);
  for (const act of actions) await call('PUT', `/api/v1/actions/${act.identifier}`, a, act);

  for (const d of connectorDefs) await call('PUT', `/api/v1/connectors/${d.identifier}`, a, d);
  for (const c of connections) await call('PUT', `/api/v1/connections/${c.identifier}`, a, c);
  for (const i of connectionIntegrations) await call('PUT', `/api/v1/integrations/${i.identifier}`, a, i);

  // A saved catalog view (the views menu of the catalog list) and a favourite action.
  await call('POST', '/api/v1/views', a, { name: 'Production services', blueprint: 'service', query: 'f=lifecycle:production&sort=title' });
  await call('PUT', '/api/v1/me/preferences', a, { favourites: ['request-environment'], recentActions: ['register-service', 'report-incident'] });

  // ---- runs, oldest first ----
  const trigger = async (token: string, action: string, body: Json) => {
    await pause(20); // distinct creation times: lists sort on them
    return (await call<RunView>('POST', `/api/v1/actions/${action}/runs`, token, body)).id;
  };

  // 1. succeeded, by the admin
  const succeeded = await trigger(a, 'register-service', {
    inputs: {
      name: 'notification-hub',
      team: 'platform',
      system: 'developer-platform',
      language: 'node',
      repositoryUrl: 'https://github.com/acme/notification-hub',
    },
  });
  await runUntil(a, succeeded, status('SUCCESS'), 'SUCCESS');

  // 2. a deployment the admin approved
  const approved = await trigger(m, 'deploy-service', {
    entity: 'ledger',
    inputs: { version: '4.13.0', environment: 'prod-eu', notes: 'Faster month-end closing.' },
  });
  await runUntil(a, approved, stepWaiting('approval__approve'), 'waiting for approval');
  await call('POST', `/api/v1/runs/${approved}/steps/approval__approve/approve`, a, { comment: 'Go ahead.' });
  await runUntil(a, approved, status('SUCCESS'), 'SUCCESS');

  // 3. a deployment the admin rejected
  const rejected = await trigger(m, 'deploy-service', { entity: 'fraud-scoring', inputs: { version: '1.0.0', environment: 'prod-eu' } });
  await runUntil(a, rejected, stepWaiting('approval__approve'), 'waiting for approval');
  await call('POST', `/api/v1/runs/${rejected}/steps/approval__approve/reject`, a, { comment: 'Still experimental: staging first.' });
  await runUntil(a, rejected, status('REJECTED', 'FAILURE', 'CANCELLED'), 'rejected');

  // 4. fails on its second step
  const failed = await trigger(a, 'archive-service', { entity: 'search-api', inputs: { reason: 'Replaced by the new search platform' } });
  await runUntil(a, failed, status('FAILURE'), 'FAILURE');

  // 5. cancelled while waiting for its approval
  const cancelled = await trigger(m, 'request-environment', {
    inputs: { name: 'perf-test', type: 'staging', region: 'northeurope', justification: 'Load test of the new checkout.' },
  });
  await runUntil(a, cancelled, (r) => r.status !== 'QUEUED', 'pending approval');
  await call('POST', `/api/v1/runs/${cancelled}/cancel`, m, {});
  await runUntil(a, cancelled, status('CANCELLED'), 'CANCELLED');

  // 6. a request waiting for the admin's approval before it starts
  const pendingRequest = await trigger(m, 'request-environment', {
    inputs: {
      name: 'prod-us',
      type: 'production',
      region: 'westeurope',
      justification: 'Launch in **North America** next quarter: we need a production environment close to customers.',
    },
  });
  await runUntil(a, pendingRequest, (r) => r.status !== 'QUEUED', 'pending approval');

  // 7. a deployment waiting on its approval step (in the middle of the workflow)
  const waitingStep = await trigger(m, 'deploy-service', {
    entity: 'payments-api',
    inputs: {
      version: '2.9.0',
      environment: 'prod-eu',
      notes: 'Adds **SEPA instant** payments.\n\n- new `/v2/transfers` endpoint\n- idempotency keys on refunds',
    },
  });
  await runUntil(a, waitingStep, stepWaiting('approval__approve'), 'waiting for approval');

  return { org: ORG, tokens: { admin: a, member: m }, runs: { waitingStep, pendingRequest, failed, succeeded: approved, rejected, cancelled } };
}

/** Seed once per data directory: a server kept running between test runs (`reuseExistingServer`) keeps its data. */
export async function seed(): Promise<SeedState> {
  if (fs.existsSync(SEED_FILE)) {
    const state = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) as SeedState;
    const me = await fetch(`${API_URL}/api/auth/me`, { headers: { authorization: `Bearer ${state.tokens.admin}` } });
    if (me.ok) return state;
  }
  const meta = await fetch(`${API_URL}/api/meta`);
  if (!meta.ok) throw new Error(`seed: the API does not answer on ${API_URL}`);
  let state: SeedState;
  try {
    state = await build();
  } catch (err) {
    throw new Error(
      `${(err as Error).message}\nThe end-to-end server may hold data from another run: stop it and remove ${path.dirname(SEED_FILE)}, then start again.`,
      { cause: err },
    );
  }
  fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify(state, null, 2));
  return state;
}

export function readSeed(): SeedState {
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) as SeedState;
}
