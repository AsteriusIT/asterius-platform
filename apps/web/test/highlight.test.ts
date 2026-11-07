import { describe, expect, it } from 'vitest';
import { tokenizeJson, tokenizeYaml, type Token } from '../src/lib/highlight';

const join = (t: Token[]) => t.map((x) => x.v).join('');
const of = (t: Token[], type: Token['t']) => t.filter((x) => x.t === type).map((x) => x.v);

describe('syntax highlighting', () => {
  it('tokenizes JSON losslessly', () => {
    const src = JSON.stringify({ name: 'svc-{{ inputs.name }}', replicas: 3, on: true, token: '${secret:T}', x: null, list: [1, 'a'] }, null, 2);
    const t = tokenizeJson(src);
    expect(join(t)).toBe(src);
    expect(of(t, 'key')).toEqual(['"name"', '"replicas"', '"on"', '"token"', '"x"', '"list"']);
    expect(of(t, 'number')).toEqual(['3', '1']);
    expect(of(t, 'literal')).toEqual(['true', 'null']);
    expect(of(t, 'template')).toEqual(['{{ inputs.name }}', '${secret:T}']);
  });

  it('tokenizes YAML losslessly: keys, items, comments, block scalars', () => {
    const src = [
      '# integration',
      'identifier: gh',
      'enabled: true',
      'intervalMinutes: 60',
      'config:',
      '  token: ${secret:GH} # from Admin → Secrets',
      'mappings:',
      '  - kind: repository',
      '    filter: "archived = false"',
      'description: |',
      '  Multi: line',
      '  text',
      'tags:',
      '  - a',
      '',
    ].join('\n');
    const t = tokenizeYaml(src);
    expect(join(t)).toBe(src);
    expect(of(t, 'key')).toEqual(['identifier', 'enabled', 'intervalMinutes', 'config', 'token', 'mappings', 'kind', 'filter', 'description', 'tags']);
    expect(of(t, 'literal')).toEqual(['true']);
    expect(of(t, 'number')).toEqual(['60']);
    expect(of(t, 'comment')).toEqual(['# integration', ' # from Admin → Secrets']);
    expect(of(t, 'template')).toEqual(['${secret:GH}']);
    expect(of(t, 'string')).toContain('  Multi: line'); // inside the block scalar: not a key
  });
});
