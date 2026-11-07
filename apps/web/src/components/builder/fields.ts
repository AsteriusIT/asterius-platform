import type { ObjectSchema, PropertySchema } from '@asterius/shared';
import { orderedFields } from '../SchemaForm';

/**
 * Form fields of an action as edited in the builder, and their mapping to/from the JSON Schema stored in
 * `action.inputs`. Schema options the builder does not know are kept in `extra`, so a round trip never loses them.
 */

export const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Whole number' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'choice', label: 'Choice' },
  { value: 'multichoice', label: 'Multiple choice' },
  { value: 'tags', label: 'List of values' },
  { value: 'email', label: 'Email' },
  { value: 'url', label: 'URL' },
  { value: 'docs', label: 'Docs (markdown URL)' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & time' },
  { value: 'team', label: 'Team' },
  { value: 'user', label: 'User' },
  { value: 'entity', label: 'Catalog entity' },
  { value: 'json', label: 'JSON object' },
] as const;

export type FieldType = (typeof FIELD_TYPES)[number]['value'];

export interface FieldDraft {
  id: string;
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  description: string;
  defaultValue: unknown;
  options: string[];
  pattern: string;
  minimum: number | undefined;
  maximum: number | undefined;
  blueprint: string;
  /** Unknown schema keys, preserved. */
  extra: Record<string, unknown>;
}

let seq = 0;
export const newId = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;

export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** "Owning team" → "owningTeam" */
export function nameFromLabel(label: string) {
  const words = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const name = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[0-9]/.test(name) ? `f${name}` : name;
}

export function emptyField(type: FieldType = 'text'): FieldDraft {
  return {
    id: newId(),
    name: '',
    label: '',
    type,
    required: false,
    description: '',
    defaultValue: undefined,
    options: [],
    pattern: '',
    minimum: undefined,
    maximum: undefined,
    blueprint: '',
    extra: {},
  };
}

const KNOWN = new Set(['type', 'title', 'description', 'format', 'enum', 'default', 'items', 'pattern', 'minimum', 'maximum', 'blueprint']);
const TEXT_FORMATS: Record<string, FieldType> = {
  markdown: 'textarea',
  text: 'textarea',
  yaml: 'textarea',
  email: 'email',
  url: 'url',
  docs: 'docs',
  date: 'date',
  'date-time': 'datetime',
  team: 'team',
  user: 'user',
  entity: 'entity',
};

function typeOf(p: PropertySchema): FieldType {
  if (p.type === 'boolean') return 'boolean';
  if (p.type === 'integer') return 'integer';
  if (p.type === 'number') return 'number';
  if (p.type === 'object') return 'json';
  if (p.type === 'array') return p.items?.enum ? 'multichoice' : 'tags';
  if (p.enum) return 'choice';
  return (p.format && TEXT_FORMATS[p.format]) || 'text';
}

export function schemaToFields(schema: ObjectSchema | undefined): FieldDraft[] {
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return orderedFields(schema).map((name) => {
    const p = schema.properties[name];
    const type = typeOf(p);
    const extra = Object.fromEntries(Object.entries(p).filter(([k]) => !KNOWN.has(k)));
    // Keep a non-default text format (e.g. yaml) that maps to the same field type.
    if (type === 'textarea' && p.format && p.format !== 'markdown') extra.format = p.format;
    return {
      id: newId(),
      name,
      label: p.title ?? '',
      type,
      required: required.has(name),
      description: p.description ?? '',
      defaultValue: p.default,
      options: ((type === 'multichoice' ? p.items?.enum : p.enum) ?? []).map(String),
      pattern: p.pattern ?? '',
      minimum: p.minimum,
      maximum: p.maximum,
      blueprint: p.blueprint ?? '',
      extra,
    };
  });
}

function fieldToProperty(f: FieldDraft): PropertySchema {
  const base: PropertySchema = { type: 'string' };
  switch (f.type) {
    case 'textarea':
      base.format = typeof f.extra.format === 'string' ? f.extra.format : 'markdown'; // keep yaml / text
      break;
    case 'number':
    case 'integer':
      base.type = f.type;
      if (f.minimum !== undefined) base.minimum = f.minimum;
      if (f.maximum !== undefined) base.maximum = f.maximum;
      break;
    case 'boolean':
      base.type = 'boolean';
      break;
    case 'choice':
      base.enum = f.options;
      break;
    case 'multichoice':
      base.type = 'array';
      base.items = { type: 'string', enum: f.options };
      break;
    case 'tags':
      base.type = 'array';
      base.items = { type: 'string' };
      break;
    case 'json':
      base.type = 'object';
      break;
    case 'datetime':
      base.format = 'date-time';
      break;
    case 'entity':
      base.format = 'entity';
      if (f.blueprint) base.blueprint = f.blueprint;
      break;
    case 'email':
    case 'url':
    case 'docs':
    case 'date':
    case 'team':
    case 'user':
      base.format = f.type;
      break;
  }
  if (f.type === 'text' && f.pattern) base.pattern = f.pattern;
  const p: PropertySchema = { ...f.extra, ...base };
  if (f.label) p.title = f.label;
  if (f.description) p.description = f.description;
  if (f.defaultValue !== undefined && f.defaultValue !== '' && f.defaultValue !== null) p.default = f.defaultValue;
  return p;
}

export function fieldsToSchema(fields: FieldDraft[]): ObjectSchema {
  const named = fields.filter((f) => f.name);
  const schema: ObjectSchema = { properties: Object.fromEntries(named.map((f) => [f.name, fieldToProperty(f)])) };
  const required = named.filter((f) => f.required).map((f) => f.name);
  if (required.length) schema.required = required;
  schema.order = named.map((f) => f.name);
  return schema;
}

/** Problems the server would reject, reported before saving. */
export function fieldProblems(fields: FieldDraft[], noun = 'Field'): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    const where = `${noun} ${i + 1}${f.label ? ` (${f.label})` : ''}`;
    if (!FIELD_NAME.test(f.name)) out.push(`${where}: the key must start with a letter and contain only letters, digits and _`);
    else if (seen.has(f.name)) out.push(`${where}: the key "${f.name}" is used twice`);
    seen.add(f.name);
    if ((f.type === 'choice' || f.type === 'multichoice') && !f.options.length) out.push(`${where}: add at least one option`);
    if (f.type === 'entity' && !f.blueprint) out.push(`${where}: choose the blueprint of the entity`);
    if (f.pattern) {
      try {
        new RegExp(f.pattern);
      } catch {
        out.push(`${where}: the pattern is not a valid regular expression`);
      }
    }
  });
  return out;
}
