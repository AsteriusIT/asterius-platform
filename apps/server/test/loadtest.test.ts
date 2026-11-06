import { describe, expect, it } from 'vitest';
import { BLUEPRINTS, blueprintDef, blueprintId, entityAt } from '../src/loadtest/seed-data.js';
import { blueprintDef as blueprintSchema } from '../src/schemas.js';

describe('load test seed data', () => {
  it('spreads 100k entities evenly over 20 blueprints with unique identifiers', () => {
    const total = 100_000;
    const perBlueprint = total / BLUEPRINTS;
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (let n = 0; n < total; n++) {
      const { blueprint, entity } = entityAt(n, BLUEPRINTS, perBlueprint);
      seen.add(`${blueprint}/${entity.identifier}`);
      counts.set(blueprint, (counts.get(blueprint) ?? 0) + 1);
    }
    expect(seen.size).toBe(total);
    expect([...counts.values()].every((c) => c === perBlueprint)).toBe(true);
  });

  it('produces valid blueprint definitions whose relations form a ring', () => {
    for (let i = 0; i < BLUEPRINTS; i++) {
      const def = blueprintSchema.parse(blueprintDef(i));
      expect(def.relations.dependsOn?.target).toBe(blueprintId((i + 1) % BLUEPRINTS));
    }
  });

  it('is deterministic and gives every entity two relations inside the seeded range', () => {
    expect(entityAt(12345)).toEqual(entityAt(12345));
    const { entity } = entityAt(99_999, BLUEPRINTS, 5000);
    expect(entity.relations.dependsOn).toHaveLength(2);
    for (const id of entity.relations.dependsOn) expect(Number(id.slice(2))).toBeLessThan(5000);
  });
});
