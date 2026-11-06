import jsonata from 'jsonata';
import { badRequest } from './errors.js';
import { LRU } from './lru.js';

/**
 * One expression language everywhere: JSONata (https://jsonata.org).
 *  - Integration mappings are plain expressions evaluated against each source item: `name`, `owner.login`, `"service"`.
 *  - Invoker configurations are templates: strings may embed `{{ expression }}` evaluated against the run context,
 *    and `${secret:NAME}` / `${env:NAME}` references resolved at execution time.
 */

const cache = new LRU<string, jsonata.Expression>(2000);

export function compile(expr: string): jsonata.Expression {
  let c = cache.get(expr);
  if (!c) {
    try {
      c = jsonata(expr);
    } catch (err) {
      throw badRequest(`Invalid expression "${expr}": ${(err as { message?: string }).message}`);
    }
    cache.set(expr, c);
  }
  return c;
}

/** Throws a 400 when an expression does not parse (used to validate configuration). */
export function checkExpression(expr: string) {
  compile(expr);
}

export async function evaluate(expr: string, data: unknown, bindings?: Record<string, unknown>): Promise<unknown> {
  const v = await compile(expr).evaluate(data, bindings);
  return normalize(v);
}

/** JSONata returns arrays with a `sequence` marker and may return functions; keep plain JSON. */
function normalize(v: unknown): unknown {
  if (v === undefined || typeof v === 'function') return undefined;
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

export type RefResolver = (kind: 'secret' | 'env', name: string) => Promise<string>;

const TOKEN = /\{\{((?:(?!\}\})[\s\S])+)\}\}|\$\{(secret|env):([A-Za-z0-9_.-]+)\}/g;

/** `"{{ expr }}"` alone (whitespace aside) keeps the expression's type (object, number…) instead of a string. */
function wholeExpression(t: string): string | undefined {
  const trimmed = t.trim();
  const tokens = [...trimmed.matchAll(TOKEN)];
  return tokens.length === 1 && tokens[0][1] !== undefined && tokens[0][0].length === trimmed.length ? tokens[0][1] : undefined;
}

const stringify = (v: unknown) => {
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v as string | number | boolean);
};

/**
 * Render a template (any JSON value). Admin-written text is tokenized once, so values coming from users
 * (inputs, entity properties) or from secrets are never re-interpreted as templates or references.
 * Returns the rendered value and the secret values it used (to redact them from logs).
 */
export async function render(template: unknown, ctx: unknown, resolveRef: RefResolver): Promise<{ value: unknown; secrets: string[] }> {
  const secrets: string[] = [];
  const walk = async (t: unknown): Promise<unknown> => {
    if (typeof t === 'string') {
      const whole = wholeExpression(t);
      if (whole !== undefined) return evaluate(whole, ctx);
      if (!t.includes('{{') && !t.includes('${')) return t;
      let out = '';
      let last = 0;
      for (const m of t.matchAll(TOKEN)) {
        out += t.slice(last, m.index);
        last = m.index + m[0].length;
        if (m[1] !== undefined) {
          out += stringify(await evaluate(m[1], ctx));
        } else {
          const secret = await resolveRef(m[2] as 'secret' | 'env', m[3]);
          if (secret) secrets.push(secret);
          out += secret;
        }
      }
      return out + t.slice(last);
    }
    if (Array.isArray(t)) return Promise.all(t.map(walk));
    if (t && typeof t === 'object') {
      const entries = await Promise.all(Object.entries(t).map(async ([k, v]) => [k, await walk(v)] as const));
      return Object.fromEntries(entries.filter(([, v]) => v !== undefined));
    }
    return t;
  };
  return { value: await walk(template), secrets };
}

/** Validate every `{{ }}` expression of a template without evaluating it. */
export function checkTemplate(template: unknown) {
  const walk = (t: unknown) => {
    if (typeof t === 'string') for (const m of t.matchAll(TOKEN)) if (m[1] !== undefined) compile(m[1]);
    if (Array.isArray(t)) t.forEach(walk);
    else if (t && typeof t === 'object') Object.values(t).forEach(walk);
  };
  walk(template);
}

/** Secrets shorter than this are not masked (masking 4-character substrings would shred ordinary text). */
export const MIN_SECRET_LENGTH = 8;

/**
 * The forms a secret takes once it travelled through a header, a URL or a JSON body: raw, URL-encoded, JSON-escaped,
 * hex, and base64 / base64url (including the three byte alignments, since `user:secret` encodes differently from `secret`).
 */
export function secretVariants(secret: string): string[] {
  const out = new Set<string>([secret]);
  const add = (v: string) => v.length >= MIN_SECRET_LENGTH && out.add(v);
  add(encodeURIComponent(secret));
  add(encodeURI(secret));
  add(JSON.stringify(secret).slice(1, -1));
  add(Buffer.from(secret).toString('hex'));
  const bytes = Buffer.from(secret);
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64');
    // Drop the characters that mix in the bytes before / after the secret, and the padding.
    const head = k ? Math.ceil((k * 8) / 6) : 0;
    const body = enc.replace(/=+$/, '');
    const tail = (k + bytes.length) % 3 ? 1 : 0;
    const core = body.slice(head, body.length - tail);
    if (core.length >= MIN_SECRET_LENGTH) {
      out.add(core);
      out.add(core.replace(/\+/g, '-').replace(/\//g, '_'));
    }
  }
  return [...out];
}

/** Replace known secret values (and their encoded forms) in persisted text: run logs, results, sync logs. */
export function redact(text: string, secrets: string[]) {
  let out = text;
  const all = new Set<string>();
  for (const s of secrets) if (s.length >= MIN_SECRET_LENGTH) for (const v of secretVariants(s)) all.add(v);
  // Longest first, so a variant that contains a shorter one is masked as a whole.
  for (const v of [...all].sort((a, b) => b.length - a.length)) out = out.split(v).join('****');
  return out;
}

/** Redact every string inside a JSON-like value. */
export function redactDeep<T>(value: T, secrets: string[]): T {
  if (!secrets.length) return value;
  if (typeof value === 'string') return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)])) as T;
  return value;
}
