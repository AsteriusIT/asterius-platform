import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Action } from '@asterius/shared';
import { audit } from '../audit.js';
import { actorOf, authenticate, bearer, isAdmin, requireAdmin, requireUser } from '../auth/users.js';
import { getEntity } from '../catalog/entities.js';
import { canTrigger, isRunnable, deleteAction, forViewer, getAction, listActions, upsertAction } from '../actions/actions.js';
import { addLog, cancelRun, decide, getRun, getRunRow, listRuns, pendingApprovals, triggerRun } from '../actions/runs.js';
import { cancelSteps, decideStep, runningInvokeStep, updateStep } from '../actions/engine.js';
import { checkRunToken, checkStepToken } from '../secrets.js';
import { conflict, forbidden } from '../lib/errors.js';
import { dryRun, previewExpression } from '../actions/dryrun.js';
import { workflowStep } from '../schemas.js';
import { entityParam, idParam, page } from './util.js';

const RUN_STATUSES = ['PENDING_APPROVAL', 'QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED'] as const;

const callbackBody = z.object({
  status: z.enum(['IN_PROGRESS', 'SUCCESS', 'FAILURE']).optional(),
  statusLabel: z.string().max(200).nullish(),
  link: z.string().url().nullish(),
  result: z.unknown().optional(),
  logs: z
    .union([z.string(), z.array(z.union([z.string(), z.object({ message: z.string(), level: z.enum(['info', 'warn', 'error']).optional() })]))])
    .optional(),
});

const normalizeLogs = (l: z.infer<typeof callbackBody>['logs']) =>
  (l === undefined ? [] : Array.isArray(l) ? l : [l]).map((x) => (typeof x === 'string' ? { message: x } : x));

export async function actionRoutes(app: FastifyInstance) {
  // ---- callback API (external systems): step token, legacy run token, or an admin API token ----
  const stepParams = z.object({ id: z.string().min(1).max(200), step: z.string().min(1).max(64) });

  async function authorizeCallback(req: FastifyRequest, runId: string, stepId?: string) {
    const token = bearer(req);
    if (stepId ? checkStepToken(runId, stepId, token) : checkRunToken(runId, token)) return;
    const p = await authenticate(req);
    if (!p || !isAdmin(p)) throw forbidden('Use the callback token of the step (run.callback.token) or an admin API token');
  }

  const parseLogs = (body: unknown) => {
    const b = z
      .object({ logs: callbackBody.shape.logs.unwrap() })
      .or(z.object({ message: z.string(), level: z.enum(['info', 'warn', 'error']).optional() }))
      .parse(body);
    return 'logs' in b ? normalizeLogs(b.logs) : [b];
  };

  const applyUpdate = async (runId: string, stepId: string, body: unknown) => {
    const b = callbackBody.parse(body);
    const applied = await updateStep(runId, stepId, {
      status: b.status,
      statusLabel: b.statusLabel,
      link: b.link,
      result: b.result,
      logs: normalizeLogs(b.logs),
    });
    if (!applied) throw conflict(`Step "${stepId}" is not running; only running steps accept updates`);
    const r = await getRunRow(runId);
    return { id: runId, step: stepId, status: r.status };
  };

  /** Workflow steps report on themselves. */
  app.patch('/runs/:id/steps/:step', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const { id, step } = stepParams.parse(req.params);
    await authorizeCallback(req, id, step);
    return applyUpdate(id, step, req.body);
  });
  app.post('/runs/:id/steps/:step/logs', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req) => {
    const { id, step } = stepParams.parse(req.params);
    await authorizeCallback(req, id, step);
    if (!(await updateStep(id, step, { logs: parseLogs(req.body) }))) throw conflict('Only running steps accept logs');
    return { ok: true };
  });

  /** Single-step (legacy) form: applies to the one running invoke step of the run. */
  app.patch('/runs/:id', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    await authorizeCallback(req, id);
    const step = await runningInvokeStep(id);
    if (!step) throw conflict(`Run is ${(await getRunRow(id)).status} with no single running step; use /runs/${id}/steps/<step>`);
    return applyUpdate(id, step, req.body);
  });
  app.post('/runs/:id/logs', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    await authorizeCallback(req, id);
    const r = await getRunRow(id);
    if (r.status !== 'IN_PROGRESS') throw conflict('Only runs in progress accept logs');
    const step = await runningInvokeStep(id);
    for (const l of parseLogs(req.body)) await addLog(id, l.message, l.level ?? 'info', step ?? null);
    return { ok: true };
  });

  // ---- everything below: signed-in users ----
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireUser);

    scoped.get('/actions', async (req) => {
      const q = z.object({ blueprint: z.string().optional(), trigger: z.enum(['create', 'day-2', 'delete']).optional() }).parse(req.query);
      return (await listActions())
        .filter((a) => (!q.blueprint || a.trigger?.blueprint === q.blueprint) && (!q.trigger || a.trigger?.on === q.trigger))
        .filter((a) => isAdmin(req.principal) || a.enabled)
        .map((a) => ({ ...forViewer(a, req.principal), allowedForMe: a.trigger?.on === 'create' ? canTrigger(a, req.principal, null) : undefined }));
    });
    scoped.get('/actions/:id', async (req) => forViewer(await getAction(idParam.parse(req.params).id), req.principal));
    scoped.put('/actions/:id', { preHandler: requireAdmin }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { action, created } = await upsertAction({ ...(req.body as object), identifier: id });
      await audit(actorOf(req.principal), created ? 'action.created' : 'action.updated', id);
      return action;
    });
    /** Editor helpers (admin): check/preview a JSONata expression, simulate a workflow on sample inputs. Nothing is executed. */
    scoped.post('/expressions/check', { preHandler: requireAdmin }, async (req) => {
      const b = z.object({ expression: z.string().max(4000), context: z.unknown().optional() }).parse(req.body);
      return previewExpression(b.expression, b.context ?? {});
    });
    scoped.post('/actions/dry-run', { preHandler: requireAdmin }, async (req) => {
      const b = z
        .object({ steps: z.array(workflowStep).max(40), inputs: z.record(z.string(), z.unknown()).default({}), entity: z.unknown().optional() })
        .parse(req.body);
      return { steps: await dryRun(b.steps, { inputs: b.inputs, entity: b.entity }) };
    });
    scoped.delete('/actions/:id', { preHandler: requireAdmin }, async (req) => {
      const { id } = idParam.parse(req.params);
      await deleteAction(id);
      await audit(actorOf(req.principal), 'action.deleted', id);
      return { ok: true };
    });

    /** Day-2 / delete actions available on an entity, with whether the caller may run them. */
    scoped.get('/blueprints/:bp/entities/:id/actions', async (req) => {
      const { bp, id } = entityParam.parse(req.params);
      const e = await getEntity(bp, id);
      return (await listActions())
        .filter((a: Action) => a.enabled && isRunnable(a) && a.trigger?.blueprint === bp && a.trigger.on !== 'create')
        .map((a) => ({ ...forViewer(a, req.principal), allowedForMe: canTrigger(a, req.principal, e.team) }));
    });

    scoped.post('/actions/:id/runs', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const body = z.object({ entity: z.string().nullish(), inputs: z.record(z.string(), z.unknown()).default({}) }).parse(req.body ?? {});
      return reply.code(201).send(await triggerRun(req.principal, id, body));
    });

    scoped.get('/runs', async (req) => {
      const q = page
        .extend({
          mine: z.enum(['true', 'false']).optional(),
          status: z.string().optional(),
          action: z.string().optional(),
          blueprint: z.string().optional(),
          entity: z.string().optional(),
        })
        .parse(req.query);
      const status = q.status ? z.array(z.enum(RUN_STATUSES)).parse(q.status.split(',')) : undefined;
      return listRuns({ ...q, status, mine: q.mine === 'true' ? req.principal.id : undefined });
    });
    scoped.get('/runs/:id', async (req) => getRun(idParam.parse(req.params).id, req.principal));
    scoped.get('/approvals', async (req) => pendingApprovals(req.principal));

    const comment = z.object({ comment: z.string().max(2000).default('') });
    scoped.post('/runs/:id/approve', async (req) => decide(req.principal, idParam.parse(req.params).id, 'approved', comment.parse(req.body ?? {}).comment));
    scoped.post('/runs/:id/reject', async (req) => decide(req.principal, idParam.parse(req.params).id, 'rejected', comment.parse(req.body ?? {}).comment));
    scoped.post('/runs/:id/cancel', async (req) => cancelRun(req.principal, idParam.parse(req.params).id, cancelSteps));
    scoped.post('/runs/:id/steps/:step/approve', async (req) => {
      const { id, step } = stepParams.parse(req.params);
      await decideStep(req.principal, id, step, 'approved', comment.parse(req.body ?? {}).comment);
      return getRun(id, req.principal);
    });
    scoped.post('/runs/:id/steps/:step/reject', async (req) => {
      const { id, step } = stepParams.parse(req.params);
      await decideStep(req.principal, id, step, 'rejected', comment.parse(req.body ?? {}).comment);
      return getRun(id, req.principal);
    });
  });
}
