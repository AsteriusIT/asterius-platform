import { describe, expect, it } from 'vitest';
import { checkTemplate, redact, render } from '../src/lib/expr.js';
import { mapItem } from '../src/integrations/mapping.js';
import { mappingDef } from '../src/schemas.js';

const secrets: Record<string, string> = { TOKEN: 'tok-123456', TPL: '{{ inputs.x }}' };
const resolve = async (kind: string, name: string) => {
  if (kind === 'secret' && secrets[name]) return secrets[name];
  throw new Error(`no ${kind} ${name}`);
};

describe('templates', () => {
  const ctx = { inputs: { name: 'billing', replicas: 3, tags: ['a', 'b'], evil: '${secret:TOKEN}' }, entity: null };

  it('keeps the type of a whole-string expression and interpolates the rest', async () => {
    const { value } = await render(
      { n: '{{ inputs.replicas }}', tags: '{{ inputs.tags }}', s: 'svc-{{ inputs.name }}-{{ inputs.replicas }}', missing: '{{ entity.identifier }}', lit: 42 },
      ctx,
      resolve,
    );
    expect(value).toEqual({ n: 3, tags: ['a', 'b'], s: 'svc-billing-3', lit: 42 });
  });

  it('treats two expressions in one string as two expressions', async () => {
    const { value } = await render('{{ inputs.name }}-{{ inputs.replicas }}', ctx, resolve);
    expect(value).toBe('billing-3');
  });

  it('resolves secret references and reports them for redaction', async () => {
    const { value, secrets: used } = await render({ h: 'Bearer ${secret:TOKEN}' }, ctx, resolve);
    expect(value).toEqual({ h: 'Bearer tok-123456' });
    expect(redact('sent Bearer tok-123456', used)).toBe('sent Bearer ****');
  });

  it('never interprets user input or secret values as templates', async () => {
    const { value } = await render({ a: '{{ inputs.evil }}', b: 'x ${secret:TPL}' }, ctx, resolve);
    expect(value).toEqual({ a: '${secret:TOKEN}', b: 'x {{ inputs.x }}' });
  });

  it('rejects invalid expressions at save time', () => {
    expect(() => checkTemplate({ url: '{{ inputs.( }}' })).toThrow(/Invalid expression/);
  });
});

describe('mappings', () => {
  it('maps, filters and converts relations', async () => {
    const m = mappingDef.parse({
      kind: 'repository',
      filter: 'archived = false',
      entity: {
        blueprint: 'repository',
        identifier: 'name',
        title: '"Repo " & name',
        properties: { lang: 'language', stars: 'stargazers_count' },
        relations: { owners: 'topics' },
      },
    });
    expect((await mapItem(m, { name: 'old', archived: true })).skipped).toBe(1);
    const { mapped } = await mapItem(m, { name: 'api', archived: false, language: 'Go', stargazers_count: 4, topics: ['a', 'b'] });
    expect(mapped).toEqual([
      {
        blueprint: 'repository',
        identifier: 'api',
        title: 'Repo api',
        team: undefined,
        properties: { lang: 'Go', stars: 4 },
        relations: { owners: ['a', 'b'] },
        delete: false,
      },
    ]);
  });

  it('fans out with items and exposes $parent and bindings', async () => {
    const m = mappingDef.parse({
      kind: 'x',
      items: 'containers',
      entity: { blueprint: 'c', identifier: '$parent.name & "/" & name', properties: { cluster: '$integration.config.cluster' } },
    });
    const { mapped } = await mapItem(m, { name: 'pod', containers: [{ name: 'app' }, { name: 'sidecar' }] }, { integration: { config: { cluster: 'prod' } } });
    expect(mapped.map((x) => [x.identifier, x.properties.cluster])).toEqual([
      ['pod/app', 'prod'],
      ['pod/sidecar', 'prod'],
    ]);
  });

  it('skips items without an identifier', async () => {
    const m = mappingDef.parse({ kind: 'x', entity: { blueprint: 'c', identifier: 'id' } });
    expect(await mapItem(m, { name: 'no id' })).toEqual({ mapped: [], skipped: 1 });
  });
});
