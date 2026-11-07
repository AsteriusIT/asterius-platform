import { config as platform } from '../../config.js';
import { all } from '../../db.js';
import { orgId } from '../../orgs/context.js';
import { deleteEntity, upsertEntity } from '../../catalog/entities.js';
import { requireFields, str, type Invoker } from '../types.js';

/**
 * Write to the catalog itself: register a resource requested through self-service (often behind an approval),
 * update properties of an entity (day-2) or remove it. No external system involved.
 */
export const catalogInvoker: Invoker = {
  info: {
    type: 'catalog',
    title: 'Catalog update',
    description: 'Create, update or delete a catalog entity from the action inputs.',
    fields: [
      { key: 'operation', label: 'Operation', kind: 'select', options: ['upsert', 'delete'] },
      { key: 'blueprint', label: 'Blueprint', kind: 'blueprint', required: true },
      { key: 'identifier', label: 'Identifier', kind: 'text', required: true, placeholder: '{{ inputs.name }}' },
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'team', label: 'Team', kind: 'text', placeholder: '{{ inputs.team }}' },
      { key: 'properties', label: 'Properties', kind: 'keyvalue' },
      { key: 'relations', label: 'Relations', kind: 'keyvalue' },
      { key: 'merge', label: 'Merge into the existing entity (keep other properties)', kind: 'boolean' },
      { key: 'cascade', label: 'Delete: also delete the entities that point to it (e.g. the repositories of a project)', kind: 'boolean', advanced: true },
    ],
    example: {
      type: 'catalog',
      operation: 'upsert',
      blueprint: 'environment',
      identifier: '{{ inputs.name }}',
      title: '{{ inputs.name }}',
      team: '{{ inputs.team }}',
      properties: { type: '{{ inputs.type }}', expiresAt: '{{ inputs.expiresAt }}' },
      relations: { service: '{{ entity.identifier }}' },
      merge: false,
    },
  },
  validate(c) {
    requireFields(c, ['blueprint', 'identifier'], 'catalog');
    if (c.operation && !['upsert', 'delete'].includes(str(c.operation))) throw new Error('catalog invoker: operation is upsert or delete');
  },
  async start({ ctx, config, log }) {
    const blueprint = str(config.blueprint);
    const identifier = str(config.identifier);
    const actor = { id: ctx.trigger.user.id, email: ctx.trigger.user.email };
    if (config.operation === 'delete') {
      const deleted = config.cascade ? await dependentsOf(blueprint, identifier) : [];
      for (const d of deleted) {
        await deleteEntity(d.blueprint, d.identifier, actor);
        await log(`Deleted ${d.blueprint}/${d.identifier} (points to ${blueprint}/${identifier})`);
      }
      await deleteEntity(blueprint, identifier, actor);
      await log(`Deleted ${blueprint}/${identifier}`);
      return { status: 'SUCCESS', result: { deleted: [...deleted, { blueprint, identifier }] } };
    }
    const { entity, created } = await upsertEntity(
      blueprint,
      { identifier, title: config.title, team: config.team || undefined, properties: config.properties ?? {}, relations: config.relations ?? {} },
      { source: 'action', actor, merge: !!config.merge },
    );
    await log(`${created ? 'Created' : 'Updated'} ${blueprint}/${identifier}`);
    return {
      status: 'SUCCESS',
      link: `${platform.PUBLIC_URL}/catalog/${blueprint}/${encodeURIComponent(entity.identifier)}`,
      result: { entity: { blueprint, identifier: entity.identifier } },
    };
  },
};

/** Entities with a relation to this one, transitively, deepest first (so each is deleted before what it points to). */
async function dependentsOf(blueprint: string, identifier: string) {
  const found = new Map<string, { blueprint: string; identifier: string }>();
  const visit = async (bp: string, id: string, depth: number) => {
    if (depth > 5) return; // relations may form cycles: a bounded walk
    const rows = await all<{ blueprint: string; identifier: string }>(
      'SELECT DISTINCT blueprint, identifier FROM entity_relations WHERE org_id = ? AND target_blueprint = ? AND target_identifier = ?',
      orgId(),
      bp,
      id,
    );
    for (const r of rows) {
      const key = `${r.blueprint}/${r.identifier}`;
      if (found.has(key) || (r.blueprint === blueprint && r.identifier === identifier)) continue;
      await visit(r.blueprint, r.identifier, depth + 1);
      found.set(key, r);
    }
  };
  await visit(blueprint, identifier, 0);
  return [...found.values()];
}
