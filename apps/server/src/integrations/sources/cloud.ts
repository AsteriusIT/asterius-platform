import { validateAuth } from '../../lib/auth.js';
import { http } from '../../lib/http.js';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

/**
 * Cloud inventories. Credentials use the shared `auth` blocks, so workload identity (IRSA, AKS workload identity,
 * GKE metadata server) works without static keys. The kind of a mapping selects what to list.
 */

// ---------- AWS Cloud Control API ----------
export const awsResourcesSource: Source = {
  info: {
    type: 'aws-resources',
    title: 'AWS resources (Cloud Control)',
    description: 'List resources of any CloudFormation type (AWS::S3::Bucket, AWS::RDS::DBInstance…) with the Cloud Control API.',
    example: {
      type: 'aws-resources',
      config: { region: 'eu-west-1', accessKeyId: '${secret:AWS_KEY_ID}', secretAccessKey: '${secret:AWS_SECRET}' },
      mappings: [{ kind: 'AWS::S3::Bucket', entity: { blueprint: 'bucket', identifier: 'identifier', properties: { region: 'properties.Region' } } }],
    },
  },
  validate(c) {
    requireFields(c, ['region'], 'aws-resources');
    validateAuth(c.auth);
  },
  async *list(kind, { config, log, incomplete }) {
    if (!/^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(kind)) throw new Error(`aws-resources: kind "${kind}" must be a resource type like AWS::S3::Bucket`);
    const endpoint = str(config.endpoint || `https://cloudcontrolapi.${str(config.region)}.amazonaws.com`).replace(/\/$/, '');
    const auth = config.auth ?? {
      type: 'aws-sigv4',
      region: str(config.region),
      service: 'cloudcontrolapi',
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
    };
    let token: string | undefined;
    let page = 0;
    do {
      const res = await http<{ ResourceDescriptions?: Array<{ Identifier: string; Properties?: string }>; NextToken?: string }>(`${endpoint}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'CloudApiService.ListResources' },
        auth,
        body: JSON.stringify({ TypeName: kind, ...(token ? { NextToken: token } : {}), MaxResults: 100 }),
        retry: undefined,
      });
      const items = (res.data.ResourceDescriptions ?? []).map((r) => {
        let properties: unknown = {};
        try {
          properties = r.Properties ? JSON.parse(r.Properties) : {};
        } catch {
          /* leave empty */
        }
        return { identifier: r.Identifier, type: kind, region: str(config.region), properties };
      });
      log(`${kind} page ${page + 1}: ${items.length} resources`);
      yield items;
      token = res.data.NextToken;
    } while (token && ++page < MAX_PAGES);
    if (token) incomplete(`stopped after ${MAX_PAGES} pages`);
  },
};

// ---------- Azure Resource Graph ----------
export const azureResourceGraphSource: Source = {
  info: {
    type: 'azure-resource-graph',
    title: 'Azure Resource Graph',
    description: 'Run Kusto (KQL) queries over Azure resources; one query per kind.',
    kinds: ['resource'],
    example: {
      type: 'azure-resource-graph',
      config: {
        subscriptions: ['00000000-0000-0000-0000-000000000000'],
        queries: { vm: "Resources | where type =~ 'microsoft.compute/virtualmachines' | project id, name, location, tags" },
        auth: { type: 'azure-managed-identity', resource: 'https://management.azure.com' },
      },
      mappings: [{ kind: 'vm', entity: { blueprint: 'server', identifier: 'name', properties: { location: 'location' } } }],
    },
  },
  validate(c) {
    const queries = (c.queries as Record<string, string> | undefined) ?? (c.query ? { resource: str(c.query) } : undefined);
    if (!queries || !Object.keys(queries).length) throw new Error('azure-resource-graph: give "queries" ({ kind: KQL }) or "query"');
    validateAuth(c.auth);
  },
  async *list(kind, { config, log, incomplete }) {
    const queries = (config.queries as Record<string, string> | undefined) ?? { resource: str(config.query) };
    const query = queries[kind];
    if (!query) throw new Error(`azure-resource-graph: no query for kind "${kind}"`);
    const endpoint = str(config.endpoint || 'https://management.azure.com').replace(/\/$/, '');
    const auth = config.auth ?? { type: 'azure-managed-identity', resource: 'https://management.azure.com' };
    let skip: string | undefined;
    let page = 0;
    do {
      const res = await http<{ data?: unknown[]; $skipToken?: string }>(`${endpoint}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`, {
        method: 'POST',
        auth,
        body: {
          query,
          ...(Array.isArray(config.subscriptions) ? { subscriptions: config.subscriptions } : {}),
          ...(Array.isArray(config.managementGroups) ? { managementGroups: config.managementGroups } : {}),
          options: { resultFormat: 'objectArray', $top: 1000, ...(skip ? { $skipToken: skip } : {}) },
        },
      });
      const rows = res.data.data ?? [];
      log(`${kind} page ${page + 1}: ${rows.length} rows`);
      yield rows;
      skip = res.data.$skipToken;
    } while (skip && ++page < MAX_PAGES);
    if (skip) incomplete(`stopped after ${MAX_PAGES} pages`);
  },
};

// ---------- GCP Cloud Asset Inventory ----------
export const gcpAssetsSource: Source = {
  info: {
    type: 'gcp-assets',
    title: 'GCP Asset Inventory',
    description: 'List assets of a project, folder or organization; the kind is the asset type.',
    example: {
      type: 'gcp-assets',
      config: { scope: 'projects/my-project', auth: { type: 'gcp-service-account' } },
      mappings: [{ kind: 'run.googleapis.com/Service', entity: { blueprint: 'cloud-run', identifier: 'name', properties: { location: 'resource.location' } } }],
    },
  },
  validate(c) {
    requireFields(c, ['scope'], 'gcp-assets');
    if (!/^(projects|folders|organizations)\/[A-Za-z0-9_.-]+$/.test(str(c.scope)))
      throw new Error('gcp-assets: scope is projects/<id>, folders/<id> or organizations/<id>');
    validateAuth(c.auth);
  },
  async *list(kind, { config, log, incomplete }) {
    const endpoint = str(config.endpoint || 'https://cloudasset.googleapis.com').replace(/\/$/, '');
    const auth = config.auth ?? { type: 'gcp-service-account' };
    let token: string | undefined;
    let page = 0;
    do {
      const q = new URLSearchParams({ contentType: 'RESOURCE', pageSize: '500', assetTypes: kind, ...(token ? { pageToken: token } : {}) });
      const res = await http<{ assets?: unknown[]; nextPageToken?: string }>(`${endpoint}/v1/${str(config.scope)}/assets?${q}`, { auth });
      const assets = res.data.assets ?? [];
      log(`${kind} page ${page + 1}: ${assets.length} assets`);
      yield assets;
      token = res.data.nextPageToken || undefined;
    } while (token && ++page < MAX_PAGES);
    if (token) incomplete(`stopped after ${MAX_PAGES} pages`);
  },
};
