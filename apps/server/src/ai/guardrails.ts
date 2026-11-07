import { badRequest } from '../lib/errors.js';
import type { WorkflowStepDef } from '../schemas.js';

type AgentStepDef = Extract<WorkflowStepDef, { type: 'agent' }>;

export interface AgentStepGuardrails {
  entityBlueprints: string[];
  actions: string[];
  httpHosts: string[];
  httpMethods: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[];
  maxWrites: number;
}

/** A write tool without its allow-list is a configuration error, never an open door. */
export function checkGuardrails(s: Pick<AgentStepDef, 'tools' | 'guardrails'>) {
  const g = s.guardrails;
  if (s.tools.includes('upsert_entity') && !g.entityBlueprints.length)
    throw badRequest('upsert_entity needs guardrails.entityBlueprints (the blueprints the agent may write)');
  if (s.tools.includes('trigger_action') && !g.actions.length) throw badRequest('trigger_action needs guardrails.actions (the actions the agent may start)');
  if (s.tools.includes('http') && !g.httpHosts.length) throw badRequest('http needs guardrails.httpHosts (the hosts the agent may call)');
}
