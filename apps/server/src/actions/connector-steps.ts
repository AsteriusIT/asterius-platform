import type { RunStepConnector, StepConnection } from '@asterius/shared';
import { listConnections } from '../integrations/connectors/connections.js';
import { findConnectorDef } from '../integrations/connectors/definitions.js';
import { fieldsWithDefaults, isReadOnlyOperation } from '../integrations/connectors/request.js';
import { listIntegrations } from '../integrations/integrations.js';
import type { ConnectorDef } from '../schemas.js';
import type { Step } from './workflow.js';

/**
 * What the workflow editor needs to build connector steps (GET /step-connections), and what the run page shows of
 * them. Day-2 actions: an operation with a `kind` applies to the blueprints that the integrations of the same
 * connection map that kind to (the editor prefills its inputs from the entity when the trigger blueprint is one of them).
 */
export async function listStepConnections(): Promise<StepConnection[]> {
  const [connections, integrations] = await Promise.all([listConnections(), listIntegrations()]);
  const out: StepConnection[] = [];
  for (const c of connections) {
    const def = await findConnectorDef(c.connector);
    if (!def) continue;
    const mapped = integrations.filter((i) => i.config?.connection === c.identifier).flatMap((i) => i.mappings);
    out.push({
      identifier: c.identifier,
      title: c.title,
      description: c.description,
      connector: { identifier: def.identifier, title: def.title, icon: def.icon ?? null },
      access: c.access,
      allowed: c.allowed,
      fields: fieldsWithDefaults(def, c.fields),
      ...(c.api ? { api: c.api } : {}),
      operations: Object.entries(def.operations).map(([name, op]) => {
        const readOnly = isReadOnlyOperation(op);
        const usable = readOnly || c.access === 'read-write';
        return {
          name,
          title: op.title,
          description: op.description,
          ...(op.kind ? { kind: op.kind } : {}),
          inputs: op.inputs as StepConnection['operations'][number]['inputs'],
          outputs: [...Object.keys(op.output ?? {}), ...Object.keys(op.poll?.output ?? {}).filter((k) => !(k in (op.output ?? {}))), 'httpStatus'],
          readOnly,
          polls: !!op.poll,
          blueprints: op.kind ? [...new Set(mapped.filter((m) => m.kind === op.kind).map((m) => m.entity.blueprint))] : [],
          usable,
          ...(usable ? {} : { reason: 'This connection is read-only and this operation changes things' }),
        };
      }),
    });
  }
  return out;
}

/** Run page: the connection and operation of each connector step (by step id). Unknown connections show their id. */
export async function runStepConnectors(defs: Step[]): Promise<Map<string, RunStepConnector>> {
  const out = new Map<string, RunStepConnector>();
  const steps = defs.filter((d) => d.type === 'invoke' && (d.invoker.type === 'connector' || d.invoker.type === 'connector-api'));
  if (!steps.length) return out;
  const connections = new Map((await listConnections()).map((c) => [c.identifier, c]));
  const defsById = new Map<string, ConnectorDef | undefined>();
  for (const s of steps) {
    if (s.type !== 'invoke') continue;
    const inv = s.invoker as Record<string, unknown>;
    const id = typeof inv.connection === 'string' ? inv.connection : '';
    if (!id || id.includes('{{')) continue;
    const conn = connections.get(id);
    if (conn && !defsById.has(conn.connector)) defsById.set(conn.connector, await findConnectorDef(conn.connector));
    const def = conn ? defsById.get(conn.connector) : undefined;
    const operation = typeof inv.operation === 'string' ? inv.operation : undefined;
    out.set(s.id, {
      connection: id,
      connectionTitle: conn?.title ?? id,
      connector: conn?.connector ?? '',
      icon: def?.icon ?? null,
      ...(s.invoker.type === 'connector'
        ? { operation, operationTitle: (operation && def?.operations[operation]?.title) || operation }
        : { method: String(inv.method ?? 'GET').toUpperCase() }),
    });
  }
  return out;
}
