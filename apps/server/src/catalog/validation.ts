import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { ObjectSchema } from '@asterius/shared';
import { badRequest } from '../lib/errors.js';

/** JSON Schema validation of entity properties and action inputs (Ajv). */

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true, coerceTypes: false });
addFormats(ajv);
ajv.addFormat('url', (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
});
// UI hints: no extra validation.
for (const f of ['markdown', 'yaml', 'team', 'user', 'entity', 'text']) ajv.addFormat(f, true);

const cache = new Map<string, ValidateFunction>();

export const toJsonSchema = (s: ObjectSchema) => ({
  type: 'object',
  properties: s.properties ?? {},
  required: s.required ?? [],
});

/** Compile (and cache) a validator; throws a 400 when the schema itself is invalid. */
export function validator(s: ObjectSchema): ValidateFunction {
  const key = JSON.stringify(s);
  let v = cache.get(key);
  if (!v) {
    try {
      v = ajv.compile(toJsonSchema(s));
    } catch (err) {
      throw badRequest(`Invalid schema: ${(err as Error).message}`);
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, v);
  }
  return v;
}

const describe = (e: ErrorObject) => {
  const where = e.instancePath ? e.instancePath.slice(1).replace(/\//g, '.') : (e.params as { missingProperty?: string }).missingProperty;
  return `${where ?? 'value'}: ${e.message}`;
};

/** Validate (and apply defaults to) `data`. Throws a 400 listing every problem. */
export function validate(s: ObjectSchema, data: Record<string, unknown>, what: string) {
  const v = validator(s);
  if (!v(data)) throw badRequest(`Invalid ${what}: ${(v.errors ?? []).map(describe).join('; ')}`, v.errors);
}

/** Drop null/undefined/empty-string values (optional fields left empty in forms). */
export function compact(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== ''));
}
