import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { config } from '../config.js';

/**
 * SSRF guard for every outbound HTTP call (invokers, pull sources, outbound webhooks).
 *
 * Destinations resolving to loopback, private, link-local (cloud metadata 169.254.169.254), CGNAT, multicast or
 * reserved ranges are refused unless the admin allows them with OUTBOUND_ALLOW (hostnames, `*.suffix`, IPs or CIDRs).
 * OUTBOUND_DENY always wins. Addresses are checked at connect time (the connection uses the address that was
 * validated, so DNS rebinding cannot swap it afterwards) and again on every redirect hop.
 */

const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const BLOCKED_V6 = ['::/128', '::1/128', '64:ff9b::/96', '100::/64', 'fc00::/7', 'fe80::/10', 'ff00::/8', '2001:db8::/32'];

interface Rules {
  hosts: string[];
  nets: net.BlockList;
}

function parseRules(entries: string[]): Rules {
  const rules: Rules = { hosts: [], nets: new net.BlockList() };
  for (const raw of entries) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    const [addr, bits] = e.split('/');
    const family = net.isIP(addr!);
    if (family) {
      const kind = family === 4 ? 'ipv4' : 'ipv6';
      if (bits !== undefined) rules.nets.addSubnet(addr!, Number(bits), kind);
      else rules.nets.addAddress(addr!, kind);
    } else rules.hosts.push(e);
  }
  return rules;
}

const builtin = new net.BlockList();
for (const c of BLOCKED_V4) builtin.addSubnet(c.split('/')[0]!, Number(c.split('/')[1]), 'ipv4');
for (const c of BLOCKED_V6) builtin.addSubnet(c.split('/')[0]!, Number(c.split('/')[1]), 'ipv6');

let allow = parseRules(config.OUTBOUND_ALLOW);
let deny = parseRules(config.OUTBOUND_DENY);
/** Replace the allow / deny lists (tests). */
export function setOutboundRules(a: string[], d: string[]) {
  allow = parseRules(a);
  deny = parseRules(d);
}

const hostMatches = (rules: Rules, host: string) => rules.hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));

/** IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is judged as the IPv4 address it carries. */
function unmap(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

const listed = (list: net.BlockList, ip: string) => {
  const a = unmap(ip);
  const f = net.isIP(a);
  return f ? list.check(a, f === 4 ? 'ipv4' : 'ipv6') : false;
};

/** Throws when `ip` (reached through `host`) is not an allowed destination. */
export function assertAddressAllowed(host: string, ip: string) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const a = unmap(ip);
  if (hostMatches(deny, h) || listed(deny.nets, a)) throw new Error(`Outbound request to ${h} is denied (OUTBOUND_DENY)`);
  if (!listed(builtin, a)) return;
  if (hostMatches(allow, h) || listed(allow.nets, a)) return;
  throw new Error(`Outbound request to ${h} (${a}) refused: private, loopback or link-local addresses are blocked (allow it with OUTBOUND_ALLOW)`);
}

/** Static checks on a URL before any DNS: scheme, denied hosts, IP literals. Hostnames are checked at connect time. */
export function assertUrlAllowed(raw: string | URL) {
  const url = typeof raw === 'string' ? new URL(raw) : raw;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported URL scheme ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) assertAddressAllowed(host, host);
  else if (hostMatches(deny, host)) throw new Error(`Outbound request to ${host} is denied (OUTBOUND_DENY)`);
}

/** True when the admin explicitly allow-listed this host or IP (OUTBOUND_ALLOW): the only case where plain http to it is acceptable. */
export function isExplicitlyAllowed(host: string) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return hostMatches(allow, h) || listed(allow.nets, h);
}

/** Same scheme, host and port: required before following a URL supplied by an upstream (pagination, redirects). */
export function sameOrigin(a: string | URL, b: string | URL) {
  return new URL(a).origin === new URL(b).origin;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** `dns.lookup` that refuses forbidden addresses: the socket connects to exactly what was validated. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '', 0);
    try {
      for (const a of addrs) assertAddressAllowed(hostname, a.address);
    } catch (e) {
      return cb(e as NodeJS.ErrnoException, '', 0);
    }
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0]!.address, addrs[0]!.family);
  });
}

export const guardedAgent = new Agent({ connect: { lookup: guardedLookup as never } });

/**
 * For non-HTTP clients (database drivers): refuse a host that is, or resolves to, a forbidden address. The driver then
 * connects on its own, so this is a check at call time (not pinned like `guardedAgent`): good against configuration
 * pointing at internal systems, not a defence against DNS rebinding.
 */
export async function assertHostAllowed(host: string) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(h)) return assertAddressAllowed(h, h);
  if (hostMatches(deny, h)) throw new Error(`Outbound request to ${h} is denied (OUTBOUND_DENY)`);
  for (const a of await dns.promises.lookup(h, { all: true })) assertAddressAllowed(h, a.address);
}

/** fetch with the SSRF guard that does not follow redirects (binary-safe alternative to `http()` for file downloads). */
export function guardedDownload(url: string, init: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
  assertUrlAllowed(url);
  return undiciFetch(url, {
    headers: init.headers,
    redirect: 'error',
    dispatcher: guardedAgent,
    signal: AbortSignal.timeout(init.timeoutMs ?? config.HTTP_TIMEOUT_SECONDS * 1000),
  }).catch((e: Error) => {
    throw e.cause instanceof Error ? e.cause : e;
  });
}
