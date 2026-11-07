import { beat, registerLoop } from './health.js';
import { createHmac } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import { all, json, run, withAdvisoryLock } from './db.js';

/**
 * Stream audit entries to a SIEM, in order and at least once. Entries carry a `streamed_at` marker set after a
 * successful hand-off, so any replica can resume after a crash and nothing is lost while the SIEM is down.
 *   AUDIT_STREAM_URL     HTTPS endpoint receiving `{ events: [...] }` (Splunk HEC proxies, Logstash, a SOAR webhook…);
 *                        AUDIT_STREAM_TOKEN adds a bearer token, AUDIT_STREAM_SECRET an HMAC-SHA256 signature header.
 *   AUDIT_SYSLOG_URL     udp://host:514 or tcp://host:514, RFC 5424 messages.
 */

interface Row {
  id: string;
  at: string;
  action: string;
  actor_email: string | null;
  target: string | null;
  detail: string;
  /** Null: platform-level (sign-ins, organization management). */
  org_id: string | null;
}

export const streamEnabled = () => !!(config.AUDIT_STREAM_URL || config.AUDIT_SYSLOG_URL);

const event = (r: Row) => ({
  id: r.id,
  at: r.at,
  organization: r.org_id,
  action: r.action,
  actor: r.actor_email,
  target: r.target,
  detail: json(r.detail, {}),
  source: 'asterius-platform',
});

/** RFC 5424: <PRI>1 TIMESTAMP HOST APP PROCID MSGID - MSG. Facility 13 (log audit), severity 6 (info). */
export const syslogLine = (r: Row, host = 'asterius') =>
  `<110>1 ${r.at} ${host} asterius-platform - ${r.action.replace(/[^\x21-\x7e]/g, '_').slice(0, 32)} - ${JSON.stringify(event(r))}`;

async function sendHttp(rows: Row[]) {
  const body = JSON.stringify({ events: rows.map(event) });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.AUDIT_STREAM_TOKEN) headers.authorization = `Bearer ${config.AUDIT_STREAM_TOKEN}`;
  if (config.AUDIT_STREAM_SECRET) headers['x-asterius-signature'] = `sha256=${createHmac('sha256', config.AUDIT_STREAM_SECRET).update(body).digest('hex')}`;
  const res = await fetch(config.AUDIT_STREAM_URL!, { method: 'POST', headers, body, signal: AbortSignal.timeout(config.HTTP_TIMEOUT_SECONDS * 1000) });
  if (!res.ok) throw new Error(`audit stream endpoint answered ${res.status}`);
}

async function sendSyslog(rows: Row[]) {
  const u = new URL(config.AUDIT_SYSLOG_URL!);
  const port = Number(u.port || 514);
  const lines = rows.map((r) => syslogLine(r));
  if (u.protocol === 'udp:') {
    const sock = dgram.createSocket(u.hostname.includes(':') ? 'udp6' : 'udp4');
    try {
      for (const l of lines) await new Promise<void>((resolve, reject) => sock.send(l, port, u.hostname, (e) => (e ? reject(e) : resolve())));
    } finally {
      sock.close();
    }
    return;
  }
  if (u.protocol !== 'tcp:') throw new Error('AUDIT_SYSLOG_URL must be udp:// or tcp://');
  await new Promise<void>((resolve, reject) => {
    const sock = net.connect({ host: u.hostname, port, timeout: config.HTTP_TIMEOUT_SECONDS * 1000 }, () => {
      // Octet-counting framing (RFC 6587): robust to newlines inside messages.
      sock.end(lines.map((l) => `${Buffer.byteLength(l)} ${l}`).join(''), () => resolve());
    });
    sock.on('error', reject);
    sock.on('timeout', () => sock.destroy(new Error('syslog connection timed out')));
  });
}

/** Send what is pending; returns how many entries were streamed. */
export async function flushAuditStream(): Promise<number> {
  if (!streamEnabled()) return 0;
  return withAdvisoryLock(726211, async () => {
    let total = 0;
    for (;;) {
      const rows = await all<Row>(
        'SELECT id, at, action, actor_email, target, detail, org_id FROM audit_log WHERE streamed_at IS NULL ORDER BY at, id LIMIT 200',
      );
      if (!rows.length) return total;
      if (config.AUDIT_STREAM_URL) await sendHttp(rows);
      if (config.AUDIT_SYSLOG_URL) await sendSyslog(rows);
      const t = new Date().toISOString();
      for (const r of rows) await run('UPDATE audit_log SET streamed_at = ? WHERE id = ?', t, r.id);
      total += rows.length;
      if (rows.length < 200) return total;
    }
  });
}

export function startAuditStream(log: FastifyBaseLogger) {
  if (!streamEnabled()) return () => undefined;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const n = await flushAuditStream();
      if (n) log.debug({ n }, 'audit entries streamed');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'audit stream failed; will retry');
    } finally {
      busy = false;
      beat('audit-stream');
    }
  };
  const timer = setInterval(() => void tick(), config.AUDIT_STREAM_INTERVAL_SECONDS * 1000);
  timer.unref();
  const unregister = registerLoop('audit-stream', Math.max(120_000, config.AUDIT_STREAM_INTERVAL_SECONDS * 6000));
  return () => {
    clearInterval(timer);
    unregister();
  };
}
