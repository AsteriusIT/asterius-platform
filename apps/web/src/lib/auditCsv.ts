import type { AuditEntry } from '@asterius/shared';

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV of audit entries: when, actor, action, target, detail (JSON). */
export function auditToCsv(entries: AuditEntry[]): string {
  const rows = entries.map((a) => [a.at, a.actorEmail ?? 'system', a.action, a.target ?? '', Object.keys(a.detail).length ? JSON.stringify(a.detail) : '']);
  return [['at', 'actor', 'action', 'target', 'detail'], ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
