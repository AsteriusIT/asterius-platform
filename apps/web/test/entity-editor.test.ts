import { describe, expect, it } from 'vitest';
import type { Blueprint, Entity } from '@asterius/shared';
import { bodyOf, draftOf } from '../src/components/EntityEditor';

const bp: Blueprint = {
  identifier: 'service',
  title: 'Service',
  description: '',
  icon: null,
  schema: { properties: { tier: { type: 'integer', default: 2 }, url: { type: 'string' }, active: { type: 'boolean' } } },
  relations: { system: { target: 'system' } },
  managed: false,
  createdAt: '',
  updatedAt: '',
};

const entity: Entity = {
  blueprint: 'service',
  identifier: 'api',
  title: 'API',
  team: 'core',
  properties: { tier: 1, legacy: 'kept' },
  relations: { system: 'billing' },
  source: 'ui',
  version: 1,
  createdAt: '',
  updatedAt: '',
};

describe('entity editor document', () => {
  it('starts a new entity from the schema defaults', () => {
    const d = draftOf(bp);
    expect(d).toMatchObject({ identifier: '', team: null, properties: { tier: 2, active: false }, relations: {} });
  });

  it('loads an existing entity and submits it without unset values', () => {
    const d = draftOf(bp, entity);
    expect(d.properties).toMatchObject({ tier: 1, active: false });
    d.properties.url = '';
    const body = bodyOf(bp, d, entity);
    // empty strings are dropped; properties unknown to the blueprint survive a PUT
    expect(body).toEqual({
      identifier: 'api',
      title: 'API',
      team: 'core',
      properties: { tier: 1, active: false, legacy: 'kept' },
      relations: { system: 'billing' },
    });
  });
});
