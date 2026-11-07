import { badRequest } from '../lib/errors.js';
import { checkExpression, checkTemplate } from '../lib/expr.js';
import { checkTimezone, nextCron, parseCron } from '../lib/cron.js';
import type { WorkflowTriggerDef } from '../schemas.js';

/** Validation of workflow triggers (shared by the API and CONFIG_DIR files) and schedule arithmetic. */

export const isFormLike = (t: WorkflowTriggerDef | null | undefined): t is Extract<WorkflowTriggerDef, { type: 'form' | 'api' }> =>
  t?.type === 'form' || t?.type === 'api';

export function validateTrigger(t: WorkflowTriggerDef) {
  try {
    switch (t.type) {
      case 'schedule':
        parseCron(t.cron);
        checkTimezone(t.timezone);
        checkTemplate(t.inputs);
        break;
      case 'event':
        if (t.filter) checkExpression(t.filter);
        if (t.event === 'run.finished' && t.blueprint) throw new Error('run.finished triggers filter by "action", not by blueprint');
        if (t.event !== 'run.finished' && t.action) throw new Error('"action" only applies to run.finished triggers');
        if (t.entity && !t.blueprint) throw new Error('An event trigger targeting an entity needs a blueprint');
        checkTemplate([t.inputs, t.entity ?? '']);
        break;
      case 'webhook':
        if (t.entity && !t.blueprint) throw new Error('A webhook trigger targeting an entity needs a blueprint');
        checkTemplate([t.inputs, t.entity ?? '']);
        break;
    }
  } catch (err) {
    throw badRequest(`Trigger: ${(err as Error).message}`);
  }
}

/** ISO time of the next tick of a schedule trigger after `from`. */
export function nextTick(t: Extract<WorkflowTriggerDef, { type: 'schedule' }>, from = Date.now()): string | null {
  const next = nextCron(parseCron(t.cron), from, t.timezone);
  return next === undefined ? null : new Date(next).toISOString();
}
