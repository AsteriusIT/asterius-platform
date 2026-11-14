import { priceCatalogDef, type PriceCatalogDef, type PriceEntry } from '../schemas.js';

/**
 * The `builtin` price catalog: a SAMPLE table of common Azure, AWS and Google Cloud resources so that plan checks
 * work out of the box. Prices are approximate public pay-as-you-go list prices in USD (Linux, no reservations, no
 * discounts, us-east / west-europe level, 2025) and power figures follow the Cloud Carbon Footprint methodology
 * (https://www.cloudcarbonfootprint.org/docs/methodology). They are estimates for comparing requests, not quotes:
 * organizations declare their own catalog (`priceCatalogs:`, negotiated prices, currency) and may `extends: builtin`.
 */

type Spec = Omit<PriceEntry, 'provider' | 'type' | 'match'> & { match?: PriceEntry['match'] };
const e = (provider: string, type: string, spec: Spec): PriceEntry => ({ provider, type, match: {}, ...spec });
const free = (provider: string, types: string[], note?: string) => types.map((type) => e(provider, type, { free: true, note }));
const usage = (provider: string, types: string[], note: string) => types.map((type) => e(provider, type, { usageBased: true, note }));

/** Compute sizes: hourly price, vCPUs, memory (GB). */
type Size = [string, number, number, number];
const AZURE_VM: Size[] = [
  ['Standard_B1s', 0.0104, 1, 1],
  ['Standard_B1ms', 0.0207, 1, 2],
  ['Standard_B2s', 0.0416, 2, 4],
  ['Standard_B2ms', 0.0832, 2, 8],
  ['Standard_B4ms', 0.166, 4, 16],
  ['Standard_D2s_v5', 0.096, 2, 8],
  ['Standard_D4s_v5', 0.192, 4, 16],
  ['Standard_D8s_v5', 0.384, 8, 32],
  ['Standard_D2s_v3', 0.096, 2, 8],
  ['Standard_D4s_v3', 0.192, 4, 16],
  ['Standard_E2s_v5', 0.126, 2, 16],
  ['Standard_E4s_v5', 0.252, 4, 32],
  ['Standard_F2s_v2', 0.0846, 2, 4],
  ['Standard_F4s_v2', 0.169, 4, 8],
];
const AWS_EC2: Size[] = [
  ['t3.micro', 0.0104, 2, 1],
  ['t3.small', 0.0208, 2, 2],
  ['t3.medium', 0.0416, 2, 4],
  ['t3.large', 0.0832, 2, 8],
  ['t3.xlarge', 0.1664, 4, 16],
  ['m5.large', 0.096, 2, 8],
  ['m5.xlarge', 0.192, 4, 16],
  ['m6i.large', 0.096, 2, 8],
  ['m6i.xlarge', 0.192, 4, 16],
  ['c5.large', 0.085, 2, 4],
  ['c6i.large', 0.085, 2, 4],
  ['r5.large', 0.126, 2, 16],
];
const AWS_RDS: Size[] = [
  ['db.t3.micro', 0.017, 2, 1],
  ['db.t3.small', 0.034, 2, 2],
  ['db.t3.medium', 0.068, 2, 4],
  ['db.t4g.micro', 0.016, 2, 1],
  ['db.m5.large', 0.171, 2, 8],
  ['db.m6i.large', 0.171, 2, 8],
  ['db.r5.large', 0.25, 2, 16],
];
const GCE: Size[] = [
  ['e2-micro', 0.0084, 2, 1],
  ['e2-small', 0.0168, 2, 2],
  ['e2-medium', 0.0335, 2, 4],
  ['e2-standard-2', 0.067, 2, 8],
  ['e2-standard-4', 0.134, 4, 16],
  ['n2-standard-2', 0.0971, 2, 8],
  ['n2-standard-4', 0.1942, 4, 16],
];
const sizes = (provider: string, type: string, attr: string, list: Size[], extra: Spec = {}) =>
  list.map(([size, hourly, vcpu, memoryGb]) => e(provider, type, { match: { [attr]: size }, hourly, vcpu, memoryGb, ...extra }));
/** Node pools: the node price times the node count. */
const pools = (provider: string, type: string, sizeAttr: string, countAttr: string, list: Size[], note?: string) =>
  list.map(([size, hourly, vcpu, memoryGb]) =>
    e(provider, type, { match: { [sizeAttr]: size }, hourly, vcpu, memoryGb, quantity: { attribute: countAttr, default: 1 }, note }),
  );
/** SSD storage power (CCF: 1.2 Wh per TB-hour) and HDD (0.65 Wh per TB-hour), per GB. */
const SSD_W = 0.0012;
const HDD_W = 0.00065;

const azure: PriceEntry[] = [
  ...sizes('azurerm', 'azurerm_linux_virtual_machine', 'size', AZURE_VM),
  ...sizes('azurerm', 'azurerm_windows_virtual_machine', 'size', AZURE_VM, { note: 'Linux price: the Windows licence is not included' }),
  ...sizes('azurerm', 'azurerm_virtual_machine', 'vm_size', AZURE_VM),
  ...sizes('azurerm', 'azurerm_linux_virtual_machine_scale_set', 'sku', AZURE_VM).map((x) => ({ ...x, quantity: { attribute: 'instances', default: 1 } })),
  ...pools(
    'azurerm',
    'azurerm_kubernetes_cluster',
    'default_node_pool.0.vm_size',
    'default_node_pool.0.node_count',
    AZURE_VM,
    'Default node pool; Free tier control plane (Standard tier: about $73/month more)',
  ),
  ...pools('azurerm', 'azurerm_kubernetes_cluster_node_pool', 'vm_size', 'node_count', AZURE_VM),
  e('azurerm', 'azurerm_managed_disk', {
    match: { storage_account_type: 'Premium_LRS' },
    perUnit: [{ attribute: 'disk_size_gb', scale: 1, default: 32, monthly: 0.15, watts: SSD_W }],
  }),
  e('azurerm', 'azurerm_managed_disk', {
    match: { storage_account_type: 'StandardSSD_LRS' },
    perUnit: [{ attribute: 'disk_size_gb', scale: 1, default: 32, monthly: 0.075, watts: SSD_W }],
  }),
  e('azurerm', 'azurerm_managed_disk', {
    match: { storage_account_type: 'Standard_LRS' },
    perUnit: [{ attribute: 'disk_size_gb', scale: 1, default: 32, monthly: 0.045, watts: HDD_W }],
  }),
  e('azurerm', 'azurerm_service_plan', { match: { sku_name: 'B1' }, monthly: 13.14, vcpu: 1, memoryGb: 1.75 }),
  e('azurerm', 'azurerm_service_plan', { match: { sku_name: 'B2' }, monthly: 26.28, vcpu: 2, memoryGb: 3.5 }),
  e('azurerm', 'azurerm_service_plan', { match: { sku_name: 'S1' }, monthly: 69.35, vcpu: 1, memoryGb: 1.75 }),
  e('azurerm', 'azurerm_service_plan', { match: { sku_name: 'P0v3' }, monthly: 62.05, vcpu: 1, memoryGb: 4 }),
  e('azurerm', 'azurerm_service_plan', { match: { sku_name: 'P1v3' }, monthly: 124.1, vcpu: 2, memoryGb: 8 }),
  e('azurerm', 'azurerm_service_plan', { match: { sku_name: 'Y1' }, usageBased: true, note: 'Consumption plan: billed per execution' }),
  e('azurerm', 'azurerm_mssql_database', { match: { sku_name: 'Basic' }, monthly: 4.9, vcpu: 0.5, memoryGb: 1 }),
  e('azurerm', 'azurerm_mssql_database', { match: { sku_name: 'S0' }, monthly: 15.03, vcpu: 0.5, memoryGb: 1 }),
  e('azurerm', 'azurerm_mssql_database', { match: { sku_name: 'S1' }, monthly: 30.05, vcpu: 1, memoryGb: 2 }),
  e('azurerm', 'azurerm_mssql_database', {
    match: { sku_name: 'GP_Gen5_2' },
    hourly: 0.505,
    vcpu: 2,
    memoryGb: 10,
    perUnit: [{ attribute: 'max_size_gb', scale: 1, default: 32, monthly: 0.115, watts: SSD_W }],
  }),
  e('azurerm', 'azurerm_mssql_database', { match: { sku_name: 'GP_S_Gen5_*' }, usageBased: true, note: 'Serverless: billed per vCore-second' }),
  e('azurerm', 'azurerm_postgresql_flexible_server', {
    match: { sku_name: 'B_Standard_B1ms' },
    hourly: 0.0207,
    vcpu: 1,
    memoryGb: 2,
    perUnit: [{ attribute: 'storage_mb', scale: 1 / 1024, default: 32, monthly: 0.115, watts: SSD_W }],
  }),
  e('azurerm', 'azurerm_postgresql_flexible_server', {
    match: { sku_name: 'GP_Standard_D2s_v3' },
    hourly: 0.178,
    vcpu: 2,
    memoryGb: 8,
    perUnit: [{ attribute: 'storage_mb', scale: 1 / 1024, default: 32, monthly: 0.115, watts: SSD_W }],
  }),
  e('azurerm', 'azurerm_redis_cache', { match: { sku_name: 'Basic', capacity: 0 }, monthly: 16.06, vcpu: 1, memoryGb: 0.25 }),
  e('azurerm', 'azurerm_redis_cache', { match: { sku_name: 'Standard', capacity: 1 }, monthly: 100.74, vcpu: 2, memoryGb: 1 }),
  e('azurerm', 'azurerm_container_registry', { match: { sku: 'Basic' }, monthly: 5 }),
  e('azurerm', 'azurerm_container_registry', { match: { sku: 'Standard' }, monthly: 20 }),
  e('azurerm', 'azurerm_container_registry', { match: { sku: 'Premium' }, monthly: 50 }),
  e('azurerm', 'azurerm_public_ip', { match: { sku: 'Standard' }, hourly: 0.005 }),
  e('azurerm', 'azurerm_public_ip', { match: { sku: 'Basic' }, hourly: 0.0036 }),
  e('azurerm', 'azurerm_lb', { match: { sku: 'Standard' }, monthly: 18.25, note: 'First 5 rules; data processed not included' }),
  e('azurerm', 'azurerm_nat_gateway', { hourly: 0.045, note: 'Data processed not included' }),
  e('azurerm', 'azurerm_private_endpoint', { hourly: 0.01, note: 'Data processed not included' }),
  e('azurerm', 'azurerm_dns_zone', { monthly: 0.5 }),
  e('azurerm', 'azurerm_private_dns_zone', { monthly: 0.5 }),
  ...usage(
    'azurerm',
    ['azurerm_storage_account', 'azurerm_key_vault', 'azurerm_log_analytics_workspace', 'azurerm_application_insights', 'azurerm_cosmosdb_account'],
    'Usage-based (capacity, operations, ingestion): not estimated from the plan',
  ),
  ...free(
    'azurerm',
    ['azurerm_linux_web_app', 'azurerm_windows_web_app', 'azurerm_linux_function_app', 'azurerm_windows_function_app'],
    'Billed through its service plan',
  ),
  ...free('azurerm', [
    'azurerm_resource_group',
    'azurerm_virtual_network',
    'azurerm_subnet',
    'azurerm_subnet_*',
    'azurerm_network_security_group',
    'azurerm_network_security_rule',
    'azurerm_network_interface',
    'azurerm_network_interface_*',
    'azurerm_route_table',
    'azurerm_route',
    'azurerm_role_assignment',
    'azurerm_role_definition',
    'azurerm_user_assigned_identity',
    'azurerm_federated_identity_credential',
    'azurerm_key_vault_secret',
    'azurerm_key_vault_access_policy',
    'azurerm_storage_container',
    'azurerm_mssql_server',
    'azurerm_mssql_firewall_rule',
    'azurerm_postgresql_flexible_server_database',
    'azurerm_postgresql_flexible_server_configuration',
    'azurerm_postgresql_flexible_server_firewall_rule',
    'azurerm_private_dns_zone_virtual_network_link',
    'azurerm_monitor_diagnostic_setting',
    'azurerm_management_lock',
  ]),
];

const aws: PriceEntry[] = [
  ...sizes('aws', 'aws_instance', 'instance_type', AWS_EC2, {
    perUnit: [{ attribute: 'root_block_device.0.volume_size', scale: 1, default: 8, monthly: 0.08, watts: SSD_W }],
  }),
  ...sizes('aws', 'aws_db_instance', 'instance_class', AWS_RDS, {
    perUnit: [{ attribute: 'allocated_storage', scale: 1, default: 20, monthly: 0.115, watts: SSD_W }],
    note: 'Single-AZ price (Multi-AZ doubles it)',
  }),
  ...pools('aws', 'aws_eks_node_group', 'instance_types.0', 'scaling_config.0.desired_size', AWS_EC2),
  ...AWS_EC2.map(([size, hourly, vcpu, memoryGb]) =>
    e('aws', 'aws_elasticache_cluster', {
      match: { node_type: `cache.${size}` },
      hourly: hourly * 1.6,
      vcpu,
      memoryGb,
      quantity: { attribute: 'num_cache_nodes', default: 1 },
    }),
  ),
  e('aws', 'aws_ebs_volume', { match: { type: 'gp3' }, perUnit: [{ attribute: 'size', scale: 1, default: 8, monthly: 0.08, watts: SSD_W }] }),
  e('aws', 'aws_ebs_volume', { match: { type: 'gp2' }, perUnit: [{ attribute: 'size', scale: 1, default: 8, monthly: 0.1, watts: SSD_W }] }),
  e('aws', 'aws_ebs_volume', {
    match: { type: ['io1', 'io2'] },
    perUnit: [{ attribute: 'size', scale: 1, default: 8, monthly: 0.125, watts: SSD_W }],
    note: 'Provisioned IOPS not included',
  }),
  e('aws', 'aws_ebs_volume', { match: { type: ['st1', 'sc1'] }, perUnit: [{ attribute: 'size', scale: 1, default: 125, monthly: 0.045, watts: HDD_W }] }),
  e('aws', 'aws_eks_cluster', { hourly: 0.1, note: 'Control plane, standard support' }),
  e('aws', 'aws_nat_gateway', { hourly: 0.045, note: 'Data processed not included' }),
  e('aws', 'aws_lb', { hourly: 0.0225, note: 'Load balancer capacity units not included' }),
  e('aws', 'aws_alb', { hourly: 0.0225, note: 'Load balancer capacity units not included' }),
  e('aws', 'aws_eip', { hourly: 0.005 }),
  e('aws', 'aws_route53_zone', { monthly: 0.5 }),
  e('aws', 'aws_kms_key', { monthly: 1 }),
  e('aws', 'aws_secretsmanager_secret', { monthly: 0.4 }),
  ...usage(
    'aws',
    ['aws_s3_bucket', 'aws_lambda_function', 'aws_dynamodb_table', 'aws_cloudwatch_log_group', 'aws_sqs_queue', 'aws_sns_topic', 'aws_ecr_repository'],
    'Usage-based (storage, requests): not estimated from the plan',
  ),
  ...free('aws', [
    'aws_vpc',
    'aws_subnet',
    'aws_security_group',
    'aws_security_group_rule',
    'aws_vpc_security_group_*',
    'aws_route_table',
    'aws_route_table_association',
    'aws_route',
    'aws_internet_gateway',
    'aws_iam_*',
    'aws_s3_bucket_*',
    'aws_db_subnet_group',
    'aws_db_parameter_group',
    'aws_elasticache_subnet_group',
    'aws_lb_target_group',
    'aws_lb_listener',
    'aws_lb_listener_rule',
    'aws_lb_target_group_attachment',
    'aws_route53_record',
    'aws_kms_alias',
    'aws_secretsmanager_secret_version',
    'aws_launch_template',
    'aws_key_pair',
  ]),
];

const google: PriceEntry[] = [
  ...sizes('google', 'google_compute_instance', 'machine_type', GCE),
  e('google', 'google_container_cluster', { hourly: 0.1, note: 'Cluster management fee; nodes are google_container_node_pool' }),
  ...pools('google', 'google_container_node_pool', 'node_config.0.machine_type', 'node_count', GCE),
  e('google', 'google_sql_database_instance', { match: { 'settings.0.tier': 'db-f1-micro' }, monthly: 7.67, vcpu: 0.2, memoryGb: 0.6 }),
  e('google', 'google_sql_database_instance', { match: { 'settings.0.tier': 'db-g1-small' }, monthly: 25.55, vcpu: 0.5, memoryGb: 1.7 }),
  e('google', 'google_compute_disk', { match: { type: 'pd-ssd' }, perUnit: [{ attribute: 'size', scale: 1, default: 10, monthly: 0.17, watts: SSD_W }] }),
  e('google', 'google_compute_disk', { match: { type: 'pd-balanced' }, perUnit: [{ attribute: 'size', scale: 1, default: 10, monthly: 0.1, watts: SSD_W }] }),
  e('google', 'google_compute_disk', { match: { type: 'pd-standard' }, perUnit: [{ attribute: 'size', scale: 1, default: 10, monthly: 0.04, watts: HDD_W }] }),
  e('google', 'google_compute_address', { hourly: 0.005 }),
  ...usage(
    'google',
    ['google_storage_bucket', 'google_cloudfunctions_function', 'google_cloud_run_service', 'google_pubsub_topic'],
    'Usage-based: not estimated from the plan',
  ),
  ...free('google', [
    'google_project_iam_*',
    'google_service_account',
    'google_service_account_*',
    'google_compute_network',
    'google_compute_subnetwork',
    'google_compute_firewall',
    'google_project_service',
    'google_sql_database',
    'google_sql_user',
    'google_storage_bucket_iam_*',
  ]),
];

/** CCF grid emission factors (kgCO2e per kWh), approximate; regions without one use the world average. */
const GRID: Record<string, number> = {
  // AWS
  'us-east-1': 0.379,
  'us-east-2': 0.411,
  'us-west-1': 0.19,
  'us-west-2': 0.136,
  'ca-central-1': 0.013,
  'eu-west-1': 0.279,
  'eu-west-2': 0.225,
  'eu-west-3': 0.051,
  'eu-central-1': 0.338,
  'eu-north-1': 0.009,
  'eu-south-1': 0.233,
  'ap-southeast-1': 0.408,
  'ap-southeast-2': 0.79,
  'ap-northeast-1': 0.466,
  'ap-south-1': 0.708,
  'sa-east-1': 0.074,
  // Azure
  eastus: 0.379,
  eastus2: 0.379,
  centralus: 0.426,
  westus: 0.19,
  westus2: 0.136,
  canadacentral: 0.013,
  northeurope: 0.279,
  westeurope: 0.328,
  uksouth: 0.225,
  ukwest: 0.225,
  francecentral: 0.051,
  germanywestcentral: 0.338,
  swedencentral: 0.009,
  norwayeast: 0.008,
  switzerlandnorth: 0.012,
  italynorth: 0.233,
  polandcentral: 0.65,
  southeastasia: 0.408,
  japaneast: 0.466,
  centralindia: 0.708,
  australiaeast: 0.79,
  brazilsouth: 0.074,
  // Google Cloud
  'us-central1': 0.454,
  'us-east1': 0.48,
  'us-west1': 0.078,
  'europe-west1': 0.167,
  'europe-west2': 0.225,
  'europe-west3': 0.338,
  'europe-west4': 0.39,
  'europe-west9': 0.051,
  'europe-north1': 0.112,
  'asia-southeast1': 0.408,
};

export const BUILTIN_CATALOG_ID = 'builtin';

export const BUILTIN_CATALOG: PriceCatalogDef = priceCatalogDef.parse({
  identifier: BUILTIN_CATALOG_ID,
  title: 'Built-in sample prices',
  description:
    'Approximate public pay-as-you-go list prices (USD, Linux, no discounts) of common Azure, AWS and Google Cloud resources, with Cloud Carbon Footprint power coefficients. A sample to start from: declare your own catalog for real prices.',
  currency: 'USD',
  hoursPerMonth: 730,
  freeProviders: [
    'random',
    'null',
    'time',
    'tls',
    'local',
    'external',
    'http',
    'archive',
    'cloudinit',
    'terraform',
    'azuread',
    'azapi',
    'kubernetes',
    'helm',
    'github',
    'azuredevops',
    'tfe',
    'vault',
  ],
  carbon: {
    pue: { azurerm: 1.185, aws: 1.135, google: 1.1 },
    gridIntensity: GRID,
    defaultGridIntensity: 0.475,
    // CCF: (min + 50 % × (max - min)) watts per vCPU, average utilisation.
    wattsPerVcpu: { azurerm: 2.27, aws: 2.12, google: 2.49 },
    wattsPerGbMemory: 0.392,
  },
  prices: [...azure, ...aws, ...google],
});
