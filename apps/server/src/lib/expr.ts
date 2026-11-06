import jsonata from 'jsonata';
import { config } from '../config.js';
import { badRequest } from './errors.js';

/**
 * One expression language everywhere: JSONata (https://jsonata.org).
 *  - Integration mappings are plain expressions evaluated against each source item: `name`, `owner.login`, `"service"`.
 *  - Invoker configurations are templates: strings may embed `{{ expression }}` evaluated against the run context,
 *    and `${secret:NAME}` / `${env:NAME}` references resolved at execution time.
 */

const cache = new Map<string, jsonata.Expression>();
const MAX_CACHE = 2000;

export function compile(expr: string): jsonata.Expression {
  let c = cache.get(expr);
  if (!c) {
    try {
      c = jsonata(expr, { timeout: config.EXPR_TIMEOUT_MS, stack: config.EXPR_MAX_DEPTH });
    } catch (err) {
      throw badRequest(`Invalid expression "${expr}": ${(err as { message?: string }).message}`);
    }
    if (cache.size > MAX_CACHE) cache.clear();
    cache.set(expr, c);
  }
  return c;
}

/** Throws a 400 when an expression does not parse (used to validate configuration). */
export function checkExpression(expr: string) {
  compile(expr);
}

export async function evaluate(expr: string, data: unknown, bindings?: Record<string, unknown>): Promise<unknown> {
  let v: unknown;
  try {
    v = await compile(expr).evaluate(data, bindings);
  } catch (err) {
    throw evaluationError(err, expr);
  }
  return normalize(v);
}

/** JSONata throws plain objects; the time and depth limits get a message that says what to do. */
function evaluationError(err: unknown, expr: string): Error {
  const e = err as { code?: string; message?: string; value?: number };
  if (e?.code === 'D1012')
    return new Error(`Expression "${expr.slice(0, 80)}" took longer than ${config.EXPR_TIMEOUT_MS} ms and was stopped (infinite loop or too much data?)`);
  if (e?.code === 'D1011')
    return new Error(`Expression "${expr.slice(0, 80)}" is nested more than ${config.EXPR_MAX_DEPTH} levels deep (non-terminating recursion?)`);
  return err instanceof Error ? err : new Error(e?.message ?? String(err));
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

/** Replace known secret values in a log line. */
export function redact(text: string, secrets: string[]) {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('****');
  return out;
}
