/**
 * Deterministic synthetic catalog for load tests (loadtest/seed.ts writes it through the API):
 * N blueprints (default 20) with the same shape, entities spread evenly, each depending on two others.
 */

export const BLUEPRINTS = 20;
export const TEAMS = 10;
const TIERS = ['gold', 'silver', 'bronze'];
const LIFECYCLES = ['production', 'staging', 'experimental', 'deprecated'];
const REGIONS = ['eu-west', 'eu-central', 'us-east', 'ap-south'];
const WORDS = ['payments', 'orders', 'billing', 'catalog', 'search', 'auth', 'gateway', 'inventory', 'shipping', 'reports', 'ledger', 'mailer'];

export const blueprintId = (i: number) => `lt-${String(i).padStart(2, '0')}`;
export const teamId = (i: number) => `lt-team-${i % TEAMS}`;
export const SEARCH_TERMS = WORDS;

export function teamDefs() {
  return Array.from({ length: TEAMS }, (_, i) => ({ identifier: teamId(i), title: `Load test team ${i}`, description: '' }));
}

export function blueprintDef(i: number, blueprints = BLUEPRINTS) {
  return {
    identifier: blueprintId(i),
    title: `Load test ${i}`,
    schema: {
      properties: {
        tier: { type: 'string', enum: TIERS },
        lifecycle: { type: 'string', enum: LIFECYCLES },
        region: { type: 'string', enum: REGIONS },
        monthlyCost: { type: 'number' },
        description: { type: 'string' },
      },
    },
    relations: { dependsOn: { title: 'Depends on', target: blueprintId((i + 1) % blueprints), many: true } },
  };
}

/** Entity number `n` (0-based, global), spread over `blueprints` blueprints of `perBlueprint` entities each. */
export function entityAt(n: number, blueprints = BLUEPRINTS, perBlueprint = 5000) {
  const bp = n % blueprints;
  const k = Math.floor(n / blueprints);
  const word = WORDS[n % WORDS.length]!;
  const target = (j: number) => `e-${String((k + j) % perBlueprint).padStart(6, '0')}`;
  return {
    blueprint: blueprintId(bp),
    entity: {
      identifier: `e-${String(k).padStart(6, '0')}`,
      title: `${word} service ${n}`,
      team: teamId(n),
      properties: {
        tier: TIERS[n % TIERS.length],
        lifecycle: LIFECYCLES[n % LIFECYCLES.length],
        region: REGIONS[n % REGIONS.length],
        monthlyCost: (n * 37) % 5000,
        description: `${word} component number ${n} of the synthetic load-test catalog`,
      },
      relations: { dependsOn: [target(1), target(7)] },
    },
  };
}
