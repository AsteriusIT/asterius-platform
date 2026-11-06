/**
 * Generate the TypeScript and Python clients from docs/openapi.json (no external generator needed):
 *   npm run clients:generate        → clients/typescript/index.ts, clients/python/asterius_client.py
 * Re-run `npm run openapi:export` first when routes change.
 */
import fs from 'node:fs';
import path from 'node:path';

type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  additionalProperties?: boolean | Schema;
  const?: unknown;
};
interface Operation {
  operationId: string;
  summary: string;
  parameters?: Array<{ name: string }>;
  requestBody?: { content: { 'application/json': { schema: Schema } } };
  responses: Record<string, { content?: { 'application/json': { schema: Schema } } }>;
}
interface Spec {
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
}

const root = path.resolve(process.argv[2] ?? '../..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'docs/openapi.json'), 'utf8')) as Spec;

const ident = (n: string) => (/^[A-Za-z_$][\w$]*$/.test(n) ? n : JSON.stringify(n));

function ts(s: Schema | undefined, indent = ''): string {
  if (!s || Object.keys(s).length === 0) return 'unknown';
  if (s.$ref) return s.$ref.split('/').pop()!;
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  const union = s.anyOf ?? s.oneOf;
  if (union) return union.map((u) => ts(u, indent)).join(' | ');
  if (s.allOf) return s.allOf.map((u) => ts(u, indent)).join(' & ');
  const types = Array.isArray(s.type) ? s.type : [s.type];
  const parts = types.map((t) => {
    switch (t) {
      case 'string':
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'array':
        return `Array<${ts(s.items, indent)}>`;
      case 'object':
      default: {
        const props = Object.entries(s.properties ?? {});
        const extra =
          s.additionalProperties === undefined || s.additionalProperties === false
            ? ''
            : `${indent}  [key: string]: ${s.additionalProperties === true ? 'unknown' : ts(s.additionalProperties, indent + '  ')};\n`;
        if (!props.length && !extra) return t === 'object' ? 'Record<string, unknown>' : 'unknown';
        const body = props.map(([k, v]) => `${indent}  ${ident(k)}${s.required?.includes(k) ? '' : '?'}: ${ts(v, indent + '  ')};\n`).join('');
        return `{\n${body}${extra}${indent}}`;
      }
    }
  });
  return parts.join(' | ');
}

const camelPath = (p: string) => p.replace(/\{(\w+)\}/g, (_m, n: string) => `\${encodeURIComponent(${n})}`);
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const ops = Object.entries(spec.paths).flatMap(([p, byMethod]) => Object.entries(byMethod).map(([method, op]) => ({ p, method: method.toUpperCase(), op })));
const responseSchema = (op: Operation) => op.responses['200']?.content?.['application/json']?.schema;

// ---------- TypeScript ----------
let out = `// Generated from docs/openapi.json (version ${spec.info.version}) by \`npm run clients:generate\`. Do not edit.\n/* eslint-disable */\n\n`;
for (const [name, schema] of Object.entries(spec.components.schemas)) out += `export type ${name} = ${ts(schema)};\n\n`;
out += `export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export interface ClientOptions {
  /** Base URL of the platform, e.g. https://portal.example.com */
  baseUrl: string;
  /** Personal API token (Admin → Tokens) */
  token: string;
  fetch?: typeof fetch;
}

export class AsteriusClient {
  constructor(private options: ClientOptions) {}

  private async request<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await (this.options.fetch ?? fetch)(url, {
      method,
      headers: { authorization: \`Bearer \${this.options.token}\`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | undefined)?.error ?? res.statusText, data);
    return data as T;
  }
`;
for (const { p, method, op } of ops) {
  const pathParams = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  const body = op.requestBody?.content['application/json'].schema;
  const args = [...pathParams.map((n) => `${n}: string`), ...(body ? [`body: ${ts(body)}`] : []), 'query?: Record<string, string | number | undefined>'];
  out += `\n  /** ${op.summary} */\n  ${op.operationId}(${args.join(', ')}): Promise<${responseSchema(op) ? ts(responseSchema(op)) : 'unknown'}> {\n    return this.request('${method}', \`${camelPath(p)}\`, { query${body ? ', body' : ''} });\n  }\n`;
}
out += '}\n';
fs.mkdirSync(path.join(root, 'clients/typescript'), { recursive: true });
fs.writeFileSync(path.join(root, 'clients/typescript/index.ts'), out);

// ---------- Python ----------
let py = `"""Asterius Platform API client. Generated from docs/openapi.json (version ${spec.info.version}) by \`npm run clients:generate\`. Do not edit.

Usage:
    client = AsteriusClient("https://portal.example.com", token="...")
    client.put_integrations_by_id("cmdb", {...})
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


class ApiError(Exception):
    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.body = body


class AsteriusClient:
    def __init__(self, base_url: str, token: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _request(self, method: str, path: str, query: Optional[dict] = None, body: Any = None) -> Any:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        data = json.dumps(body).encode() if body is not None else None
        headers = {"authorization": f"Bearer {self.token}", "accept": "application/json"}
        if data is not None:
            headers["content-type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                text = res.read().decode()
        except urllib.error.HTTPError as err:
            text = err.read().decode()
            parsed = json.loads(text) if text else None
            raise ApiError(err.code, (parsed or {}).get("error", err.reason) if isinstance(parsed, dict) else err.reason, parsed) from err
        return json.loads(text) if text else None
`;
for (const { p, method, op } of ops) {
  const pathParams = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  const hasBody = !!op.requestBody;
  const args = ['self', ...pathParams.map((n) => `${snake(n)}: str`), ...(hasBody ? ['body: dict'] : []), 'query: Optional[dict] = None'];
  const pathExpr = `f"${p.replace(/\{(\w+)\}/g, (_m, n: string) => `{urllib.parse.quote(${snake(n)}, safe='')}`)}"`;
  py += `\n    def ${snake(op.operationId)}(${args.join(', ')}) -> Any:\n        """${op.summary}"""\n        return self._request("${method}", ${pathExpr}, query${hasBody ? ', body' : ''})\n`;
}
fs.mkdirSync(path.join(root, 'clients/python'), { recursive: true });
fs.writeFileSync(path.join(root, 'clients/python/asterius_client.py'), py);
console.log(`generated ${ops.length} operations`);
