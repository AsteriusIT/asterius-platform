import type { PlanChangeAction } from '@asterius/shared';

/**
 * Terraform / OpenTofu plans in the machine-readable format of `terraform show -json plan.out` (`tofu show -json`):
 * `resource_changes[]` with `change.actions`, `change.before` (current state) and `change.after` (planned values).
 * Only managed resources are kept (data sources are reads); `after_unknown` values are simply absent.
 */

export interface PlanResource {
  address: string;
  module: string | null;
  type: string;
  name: string;
  /** Provider short name: `registry.opentofu.org/hashicorp/azurerm` → `azurerm`. */
  provider: string;
  action: PlanChangeAction;
  /** Attributes before (null when created) and after (null when deleted) the change. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  region: string | null;
}

export interface Plan {
  raw: Record<string, unknown>;
  terraformVersion: string | null;
  resources: PlanResource[];
}

interface RawChange {
  address?: string;
  module_address?: string;
  mode?: string;
  type?: string;
  name?: string;
  provider_name?: string;
  change?: { actions?: string[]; before?: unknown; after?: unknown };
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export const providerShort = (name: string) =>
  name
    .split('/')
    .pop()!
    .replace(/^terraform-provider-/, '');

/** `["create"]` → create, `["delete","create"]` / `["create","delete"]` → replace, `["read"]` → null (not a change). */
export function changeAction(actions: string[] | undefined): PlanChangeAction | null {
  const a = actions ?? [];
  if (a.includes('create') && a.includes('delete')) return 'replace';
  if (a.length === 1 && ['create', 'update', 'delete', 'no-op', 'forget'].includes(a[0]!)) return a[0] as PlanChangeAction;
  if (a.includes('forget')) return 'forget';
  return null;
}

/** Azure locations are spelled `West Europe` or `westeurope`: one form. */
const normRegion = (v: string) => v.toLowerCase().replace(/\s+/g, '');

/** The region of a resource: its own `location` / `region` / zone, else the provider's configured region. */
function regionOf(attrs: Record<string, unknown> | null, providerRegion: string | undefined): string | null {
  const a = attrs ?? {};
  for (const k of ['location', 'region']) if (typeof a[k] === 'string' && a[k]) return normRegion(a[k]);
  if (typeof a.zone === 'string' && /-[a-z]$/.test(a.zone)) return a.zone.replace(/-[a-z]$/, ''); // google: europe-west1-b
  if (typeof a.availability_zone === 'string' && /\d[a-z]$/.test(a.availability_zone)) return a.availability_zone.slice(0, -1); // aws: eu-west-1a
  return providerRegion ? normRegion(providerRegion) : null;
}

/** `configuration.provider_config.<name>.expressions.region.constant_value` (aws, google). */
function providerRegions(raw: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const cfg = obj(obj(raw.configuration)?.provider_config) ?? {};
  for (const [key, p] of Object.entries(cfg)) {
    const e = obj(obj(p)?.expressions);
    const region = obj(e?.region)?.constant_value ?? obj(e?.location)?.constant_value;
    if (typeof region === 'string' && !key.includes('.')) out.set(providerShort(String(obj(p)?.name ?? key)), region); // aliases (aws.eu) skipped
  }
  return out;
}

/** Parse a plan (object or JSON text); throws with a readable message when it is not a plan. */
export function parsePlan(input: unknown): Plan {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      throw new Error('The plan is not valid JSON (expected the output of `terraform show -json` / `tofu show -json`)');
    }
  }
  const raw = obj(v);
  if (!raw) throw new Error('The plan must be a JSON object');
  if (!Array.isArray(raw.resource_changes)) {
    if (raw.format_version !== undefined) return { raw, terraformVersion: str(raw.terraform_version), resources: [] }; // nothing to change
    throw new Error('Not a Terraform / OpenTofu plan: resource_changes is missing (use `terraform show -json <planfile>`)');
  }
  const regions = providerRegions(raw);
  const resources: PlanResource[] = [];
  for (const rc of raw.resource_changes as RawChange[]) {
    if (!rc || rc.mode === 'data') continue;
    const action = changeAction(rc.change?.actions);
    if (!action) continue;
    const provider = providerShort(rc.provider_name ?? '');
    const before = obj(rc.change?.before);
    const after = action === 'delete' ? null : obj(rc.change?.after);
    resources.push({
      address: String(rc.address ?? `${rc.type}.${rc.name}`),
      module: rc.module_address ?? null,
      type: String(rc.type ?? ''),
      name: String(rc.name ?? ''),
      provider,
      action,
      before: action === 'create' ? null : before,
      after,
      region: regionOf(after ?? before, regions.get(provider)),
    });
  }
  return { raw, terraformVersion: str(raw.terraform_version), resources };
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** `a.b.0.c` in Terraform values (nested blocks are lists). */
export function getPath(o: unknown, path: string): unknown {
  let cur = o;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = /^\d+$/.test(seg) ? cur[Number(seg)] : undefined;
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}
