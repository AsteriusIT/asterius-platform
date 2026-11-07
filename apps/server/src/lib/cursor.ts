import type { FastifyReply, FastifyRequest } from 'fastify';
import { badRequest } from './errors.js';

/** Opaque keyset cursors: the sort key (and direction) of the last row of a page, base64url JSON. */
export interface Cursor {
  /** Sort identifier, so a cursor cannot be replayed against another ordering. */
  s: string;
  d: string;
  v: string[];
}

export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

export function decodeCursor(raw: string, expected: { s: string; d: string; n: number }): string[] {
  let c: Cursor | undefined;
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
  } catch {
    c = undefined;
  }
  if (!c || typeof c.s !== 'string' || typeof c.d !== 'string' || !Array.isArray(c.v) || !c.v.every((x) => typeof x === 'string'))
    throw badRequest('Invalid cursor');
  if (c.s !== expected.s || c.d !== expected.d || c.v.length !== expected.n) throw badRequest('Cursor does not match the requested sort');
  return c.v;
}

/** Advertise the next page: `Link: <url>; rel="next"` plus `X-Next-Cursor` (for endpoints that return a bare array). */
export function nextPageHeaders(req: FastifyRequest, reply: FastifyReply, next: string | undefined) {
  if (!next) return;
  const url = new URL(req.url, 'http://localhost');
  url.searchParams.set('cursor', next);
  url.searchParams.delete('offset');
  reply.header('link', `<${url.pathname}${url.search}>; rel="next"`).header('x-next-cursor', next);
}
