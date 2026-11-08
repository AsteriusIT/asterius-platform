import { createHash } from 'node:crypto';

/**
 * Names fixed by the V2 contract (docs/V2-KIND.md): annotations and labels written on the Service spec, and the
 * label-safe form of a portal run id.
 */

export const ANN = {
  runId: 'portal.asterius.io/run-id',
  requestedBy: 'portal.asterius.io/requested-by',
  paused: 'portal.asterius.io/paused',
  pausedReason: 'portal.asterius.io/paused-reason',
  decommissionRunId: 'portal.asterius.io/decommission-run-id',
} as const;

export const LABEL = {
  runId: 'portal.asterius.io/run-id',
  team: 'portal.asterius.io/team',
  service: 'portal.asterius.io/service',
  protected: 'protected',
} as const;

/** Kubernetes label value: at most 63 characters, alphanumerics at both ends, `-`, `_` and `.` inside (or empty). */
export const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;
/** DNS-1123 label: team and service names (they become namespaces, resource names and label values). */
export const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * Name limits of the Service schema (Portal repo XRD: `spec.owner` is `^[a-z][a-z0-9-]{1,19}$`) and of the deterministic
 * names derived from them: ADO project `<team>-<service>` (ADO: at most 64 characters), pipeline `<service>-ci`,
 * namespace `team-<team>`. Checked by the portal before anything is committed (pre-check and preview).
 */
export const TEAM_MIN = 2;
export const TEAM_MAX = 20;
export const SERVICE_MIN = 2;
export const SERVICE_MAX = 30;
export const TEAM_PATTERN = `^[a-z][a-z0-9-]{${TEAM_MIN - 1},${TEAM_MAX - 1}}$`;
export const SERVICE_PATTERN = `^[a-z][a-z0-9-]{${SERVICE_MIN - 2},${SERVICE_MAX - 2}}[a-z0-9]$`;

export const isLabelValue = (v: string) => v.length <= 63 && LABEL_VALUE.test(v);

/**
 * The run id as a label value. Portal run ids are UUIDs (36 characters of `[0-9a-f-]`), which are valid label values
 * and are used as is, so the label equals the annotation. Any other id (longer, or with characters labels cannot hold)
 * is turned into `<sanitized prefix>-<10 hex chars of sha256(id)>`: deterministic, so every hop derives the same value,
 * and the full id stays in the `portal.asterius.io/run-id` annotation.
 */
export function labelSafeRunId(id: string): string {
  if (isLabelValue(id)) return id;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 10);
  const prefix = id
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .slice(0, 52)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  return prefix ? `${prefix}-${hash}` : hash;
}
