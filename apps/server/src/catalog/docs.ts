import type { Blueprint, Entity } from '@asterius/shared';
import { badRequest, notFound } from '../lib/errors.js';
import { guardedDownload } from '../lib/netguard.js';

/** Entity documentation (TechDocs-style): markdown fetched server-side from the URL in a `docs`-format property. */

export const DOCS_MAX_BYTES = 1_000_000;
const DOCS_TIMEOUT_MS = 10_000;

/** GitHub / GitLab "blob" page URLs point at HTML; the raw file lives elsewhere. */
export function toRawDocsUrl(raw: string): string {
  const u = new URL(raw);
  if (u.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  if (/^\/.+\/-\/blob\//.test(u.pathname) && u.hostname.includes('gitlab')) {
    u.pathname = u.pathname.replace('/-/blob/', '/-/raw/');
    return u.toString();
  }
  return raw;
}

/** The first `docs` property of the blueprint holding a value (or the named one). */
export function docsUrlOf(bp: Blueprint, e: Entity, property?: string): { property: string; url: string } {
  const props = bp.schema.properties ?? {};
  const keys = Object.keys(props).filter((k) => props[k]!.format === 'docs' && (!property || k === property));
  for (const k of keys) {
    const v = e.properties[k];
    if (typeof v === 'string' && v.trim()) return { property: k, url: v.trim() };
  }
  throw notFound(`Docs of ${e.blueprint}/${e.identifier}`);
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw badRequest(`The documentation is larger than ${max / 1000} KB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchDocs(url: string): Promise<{ url: string; markdown: string }> {
  let target: string;
  try {
    target = toRawDocsUrl(url);
  } catch {
    throw badRequest('The docs URL is not valid');
  }
  let res;
  try {
    res = await guardedDownload(target, { timeoutMs: DOCS_TIMEOUT_MS, headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' } });
  } catch (e) {
    throw badRequest(`Could not fetch the documentation: ${(e as Error).message}`);
  }
  if (!res.ok) throw badRequest(`Could not fetch the documentation: the server answered ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (type && !/^text\/|markdown|application\/octet-stream/i.test(type)) throw badRequest(`The documentation is not a text file (${type})`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > DOCS_MAX_BYTES) throw badRequest(`The documentation is larger than ${DOCS_MAX_BYTES / 1000} KB`);
  try {
    return { url: target, markdown: await readCapped(res as unknown as Response, DOCS_MAX_BYTES) };
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode) throw e;
    throw badRequest(`Could not fetch the documentation: ${(e as Error).message}`);
  }
}
