import type { ObjectSchema, PluginField } from '@asterius/shared';

/**
 * Helpers of the workflow editor's connector steps (components/builder/ConnectorStepEditor.tsx): the operation's input
 * schema as step fields (each accepts a literal or a `{{ }}` template), the inputs of the request preview, and the day-2
 * prefill from the entity the workflow runs on.
 */

export const CONNECTOR_INVOKERS = ['connector', 'connector-api'];

type Prop = { type?: string; title?: string; description?: string; enum?: unknown[]; format?: string };

const props = (schema: ObjectSchema | undefined) => (schema?.properties ?? {}) as Record<string, Prop>;

/** Does the value contain a template or a reference (rendered when the step runs)? */
export const isDynamic = (v: unknown): boolean =>
  typeof v === 'string'
    ? v.includes('{{') || v.includes('${')
    : Array.isArray(v)
      ? v.some(isDynamic)
      : !!v && typeof v === 'object' && Object.values(v).some(isDynamic);

/** One step field per input, in the schema's order. Enumerations stay text fields (they may be templates). */
export function operationFields(schema: ObjectSchema | undefined): PluginField[] {
  const p = props(schema);
  const order = [...((schema as { order?: string[] } | undefined)?.order ?? []).filter((k) => k in p), ...Object.keys(p)];
  const required = new Set(schema?.required ?? []);
  return [...new Set(order)].map((key) => {
    const prop = p[key]!;
    const kind: PluginField['kind'] =
      prop.type === 'integer' || prop.type === 'number'
        ? 'number'
        : prop.type === 'boolean'
          ? 'boolean'
          : prop.type === 'object'
            ? 'keyvalue'
            : prop.type === 'array'
              ? 'list'
              : prop.format === 'markdown'
                ? 'textarea'
                : 'text';
    const help = [prop.description, prop.enum?.length ? `One of: ${prop.enum.map(String).join(', ')}` : ''].filter(Boolean).join(' · ');
    return { key, label: prop.title ?? key, kind, required: required.has(key), ...(help ? { help } : {}) };
  });
}

/**
 * Inputs for the request preview: literals as they are; templates in text fields are kept as their text (shown
 * unrendered), templates in other fields are replaced by a sample of the field's type so the preview can render.
 */
export function previewInputs(schema: ObjectSchema | undefined, inputs: Record<string, unknown> | undefined): Record<string, unknown> {
  const p = props(schema);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs ?? {})) {
    if (!isDynamic(v)) out[k] = v;
    else {
      const t = p[k]?.type ?? 'string';
      out[k] = t === 'string' ? v : ({ integer: 0, number: 0, boolean: false, object: {}, array: [] } as Record<string, unknown>)[t];
    }
  }
  return out;
}

/**
 * Day-2 prefill: the empty inputs named like a property of the entity's blueprint get `{{ entity.properties.<name> }}`,
 * and an empty `name` / `identifier` gets `{{ entity.identifier }}`. Inputs already set are kept.
 */
export function entityPrefill(
  schema: ObjectSchema | undefined,
  blueprintProperties: string[],
  inputs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(inputs ?? {}) };
  for (const key of Object.keys(props(schema))) {
    if (out[key] !== undefined && out[key] !== '') continue;
    if (blueprintProperties.includes(key)) out[key] = `{{ entity.properties.${key} }}`;
    else if (key === 'name' || key === 'identifier') out[key] = '{{ entity.identifier }}';
  }
  return out;
}
