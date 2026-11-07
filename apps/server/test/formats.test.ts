import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseCsv, parsePayload } from '../src/lib/formats.js';
import { graphqlSource, httpSource, nextPage } from '../src/integrations/sources/http.js';
import type { SourceEnv } from '../src/integrations/types.js';

describe('payload formats', () => {
  it('parses CSV with quotes, escaped quotes and embedded newlines', () => {
    expect(parseCsv('name,desc\r\n"Al, the ""first""","line1\nline2"\nBo,plain\n')).toEqual([
      { name: 'Al, the "first"', desc: 'line1\nline2' },
      { name: 'Bo', desc: 'plain' },
    ]);
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([{ a: '1', b: '2' }]);
  });
  it('parses YAML and XML and detects the format', () => {
    expect(parsePayload('- name: a\n  tier: 1\n', 'yaml')).toEqual([{ name: 'a', tier: 1 }]);
    expect(parsePayload('<apps><app id="1"><name>A</name></app><app id="2"><name>B</name></app></apps>', 'xml')).toEqual({
      apps: {
        app: [
          { '@_id': '1', name: 'A' },
          { '@_id': '2', name: 'B' },
        ],
      },
    });
    expect(parsePayload('{"a":1}', 'auto', 'text/plain')).toEqual({ a: 1 });
    expect(parsePayload('a,b\n1,2', 'auto', 'text/csv')).toEqual([{ a: '1', b: '2' }]);
    expect(() => parsePayload('{oops', 'json')).toThrow(/cannot parse the response as json/);
  });
});

describe('pagination strategies', () => {
  const base = { url: 'https://x.test/api?q=1', body: undefined, headers: new Headers(), page: 0, items: 2, fetched: 2 };
  it('offset, page and cursor', async () => {
    expect((await nextPage({ type: 'offset', param: 'offset', pageSize: 2 }, { ...base, data: {} }))?.url).toBe('https://x.test/api?q=1&offset=2');
    expect(await nextPage({ type: 'offset', param: 'offset', pageSize: 5 }, { ...base, data: {} })).toBeUndefined(); // short page
    expect(await nextPage({ type: 'offset', param: 'offset', pageSize: 2, totalPath: 'total' }, { ...base, data: { total: 2 } })).toBeUndefined();
    expect((await nextPage({ type: 'page', param: 'page', pageSize: 2 }, { ...base, data: {} }))?.url).toBe('https://x.test/api?q=1&page=2');
    expect((await nextPage({ type: 'cursor', param: 'after', cursorPath: 'meta.next' }, { ...base, data: { meta: { next: 'abc' } } }))?.url).toContain(
      'after=abc',
    );
    expect(await nextPage({ type: 'cursor', param: 'after', cursorPath: 'meta.next' }, { ...base, data: { meta: {} } })).toBeUndefined();
    const b = await nextPage({ type: 'cursor', param: 'cursor', cursorPath: 'next', in: 'body' }, { ...base, body: { q: 1 }, data: { next: 'zz' } });
    expect(b?.body).toEqual({ q: 1, cursor: 'zz' });
  });
});

async function api(handler: (url: string, body: string) => unknown, contentType = 'application/json') {
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const out = handler(req.url ?? '', body);
      res.writeHead(200, { 'content-type': contentType }).end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise((r) => s.close(r)) };
}
const env = (config: Record<string, unknown>): SourceEnv => ({
  config,
  log: () => undefined,
  startedAt: '',
  setState: () => undefined,
  incomplete: () => undefined,
});
async function collect(src: typeof httpSource, config: Record<string, unknown>) {
  const out: unknown[] = [];
  for await (const page of src.list!('item', env(config))) out.push(...page);
  return out;
}

describe('http and graphql sources', () => {
  it('ingests a CSV listing paged by offset', async () => {
    const rows = ['a', 'b', 'c'];
    const s = await api((url) => {
      const off = Number(new URL(url, 'http://x').searchParams.get('offset') ?? 0);
      return `code\n${rows.slice(off, off + 2).join('\n')}\n`;
    }, 'text/csv');
    const items = await collect(httpSource, { url: `${s.url}/l`, format: 'csv', pagination: { type: 'offset', param: 'offset', pageSize: 2 } });
    expect(items).toEqual([{ code: 'a' }, { code: 'b' }, { code: 'c' }]);
    await s.close();
  });

  it('pages a GraphQL query through pageInfo', async () => {
    const s = await api((_u, body) => {
      const after = (JSON.parse(body) as { variables: { after?: string } }).variables.after;
      return after
        ? { data: { r: { nodes: [{ name: 'c' }], pageInfo: { hasNextPage: false, endCursor: null } } } }
        : { data: { r: { nodes: [{ name: 'a' }, { name: 'b' }], pageInfo: { hasNextPage: true, endCursor: 'X' } } } };
    });
    const items = await collect(graphqlSource, { url: `${s.url}/graphql`, query: '{ r }', itemsPath: 'data.r.nodes', pageInfoPath: 'data.r.pageInfo' });
    expect(items).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    await s.close();
    const e = await api(() => ({ errors: [{ message: 'boom' }] }));
    await expect(collect(graphqlSource, { url: `${e.url}/g`, query: '{ r }' })).rejects.toThrow(/boom/);
    await e.close();
  });
});
