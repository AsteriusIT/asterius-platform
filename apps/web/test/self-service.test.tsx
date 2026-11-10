import { afterEach, describe, expect, it } from 'vitest';
import { validateValues } from '../src/components/SchemaForm';
import { clearDraft, loadDraft, parseInputsParam, saveDraft } from '../src/lib/drafts';

afterEach(() => localStorage.clear());

describe('validateValues', () => {
  const schema = {
    properties: {
      name: { type: 'string' as const, minLength: 3, maxLength: 5 },
      mail: { type: 'string' as const, format: 'email' },
      size: { type: 'integer' as const, minimum: 1, maximum: 10 },
      tags: { type: 'array' as const, maxItems: 1 },
    },
  };
  it('checks lengths, formats, ranges and item counts', () => {
    expect(validateValues(schema, { name: 'ab', mail: 'x', size: 11, tags: ['a', 'b'] })).toEqual({
      name: 'At least 3 characters',
      mail: 'Must be an email address',
      size: 'At most 10',
      tags: 'At most 1 items',
    });
    expect(validateValues(schema, { name: 'abcd', mail: 'a@b.co', size: 2, tags: [] })).toEqual({});
  });
});

describe('drafts', () => {
  it('saves, loads and clears per action and entity', () => {
    saveDraft('a', 'e1', { x: 1 });
    expect(loadDraft('a', 'e1')).toEqual({ x: 1 });
    expect(loadDraft('a', null)).toBeNull();
    clearDraft('a', 'e1');
    expect(loadDraft('a', 'e1')).toBeNull();
  });
  it('parses the inputs param defensively', () => {
    expect(parseInputsParam('{"a":1}')).toEqual({ a: 1 });
    expect(parseInputsParam('[1]')).toBeNull();
    expect(parseInputsParam('nope')).toBeNull();
  });
});
