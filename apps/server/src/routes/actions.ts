import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Action } from '@asterius/shared';
import { audit } from '../audit.js';
import { actorOf, authenticate, bearer, isAdmin, requireAdmin, requireUser } from '../auth/users.js';
import { getEntity } from '../catalog/entities.js';
import { blueprintOf, canTrigger, isRunnable, deleteAction, forViewer, getAction, listActions, upsertAction } from '../actions/actions.js';
import { nextPageHeaders } from '../lib/cursor.js';
import { addLog, cancelRun, decide, getRun, getRunLogs, getRunRow, listRuns, pendingApprovals, runLogsAfter, triggerRun } from '../actions/runs.js';
import { runPriority, workflowStep } from '../schemas.js';
import { forceStep, pauseRun, unpauseRun } from '../actions/operations.js';
import { previewExpression, simulateWorkflow } from '../actions/simulate.js';
import { runOrg } from '../actions/runs.js';
import { DEFAULT_ORG, enterOrg, withOrg } from '../orgs/context.js';
import { findOrg } from '../orgs/orgs.js';
import { cancelSteps, decideStep, runningInvokeStep, updateStep } from '../actions/engine.js';
import { dryRun } from '../actions/dryrun.js';
import { diffVersions, getVersion, listVersions } from '../actions/versions.js';
import { rerun, resume, retryStep } from '../actions/recovery.js';
import { deliverEvent, submitInput } from '../actions/waiting.js';
import { receiveWebhook } from '../actions/triggers.js';
import { checkRunToken, checkStepToken } from '../secrets.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { ifMatchOf } from '../lib/conflict.js';
import { entityParam, idParam, page } from './util.js';
import { addArtifact, artifactBodyLimit, contentDisposition, getArtifact, listArtifacts } from '../actions/artifacts.js';
import { canManageRun } from '../actions/steps.js';
import { FINAL } from '../actions/runs.js';
import { runWorkflowTests } from '../actions/workflow-tests.js';

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

  /** Callbacks work in the run's organization: its step token, or an admin token of that organization. */
  async function authorizeCallback(req: FastifyRequest, runId: string, stepId?: string) {
    const org = await runOrg(runId);
    if (!org) throw notFound('Run');
    const token = bearer(req);
    if (stepId ? checkStepToken(runId, stepId, token) : checkRunToken(runId, token)) return enterOrg(org);
    const p = await authenticate(req);
    if (!p || !isAdmin(p) || p.org?.id !== org) throw forbidden('Use the callback token of the step (run.callback.token) or an admin API token');
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

  /** External signal for a `wait` step (`event`): authenticated by the step token or an admin token. */
  app.post('/runs/:id/steps/:step/events', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id, step } = stepParams.parse(req.params);
    await authorizeCallback(req, id, step);
    const body = z.object({ name: z.string().min(1).max(100), payload: z.unknown().optional() }).parse(req.body ?? {});
    const delivered = await deliverEvent(id, step, body.name, body.payload);
    return reply.code(delivered ? 200 : 202).send({ delivered });
  });

  /**
   * Attach a file to a step (JSON: `{ name, contentType, content }`, content in base64). Authenticated by the step's
   * callback token while the run is not finished, or by the requester / an admin (any time).
   */
  const artifactBody = z.object({ name: z.string().min(1).max(500), contentType: z.string().min(1).max(200), content: z.string() });
  app.post(
    '/runs/:id/steps/:step/artifacts',
    { bodyLimit: artifactBodyLimit(), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id, step } = stepParams.parse(req.params);
      const org = await runOrg(id);
      if (!org) throw notFound('Run');
      let createdBy: string;
      if (checkStepToken(id, step, bearer(req))) {
        enterOrg(org);
        if (FINAL.includes((await getRunRow(id)).status)) throw conflict('The run is finished: its steps no longer accept artifacts');
        createdBy = `step:${step}`;
      } else {
        const p = await authenticate(req);
        if (!p) return reply.code(401).send({ error: 'unauthorized' });
        if (p.org?.id !== org) throw notFound('Run');
        if (!canManageRun(p, await getRunRow(id))) throw forbidden('Only the requester or an admin can attach artifacts to this run');
        createdBy = p.email;
      }
      return reply.code(201).send(await addArtifact(id, step, artifactBody.parse(req.body ?? {}), createdBy));
    },
  );

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
    if (step)
      await updateStep(id, step, { logs: parseLogs(req.body) }); // masks secrets
    else for (const l of parseLogs(req.body)) await addLog(id, l.message, l.level ?? 'info', null);
    return { ok: true };
  });

  /**
   * Inbound webhook trigger: starts the workflow named in the URL, in the organization named before it
   * (`/hooks/<organization>/<action>`; `/hooks/<action>`: the default organization). Authenticated by the trigger's
   * secret (token or HMAC).
   */
  const hook = async (req: FastifyRequest, orgKey: string, id: string) => {
    const org = await findOrg(orgKey);
    if (!org) throw notFound('Webhook trigger');
    return withOrg(org.id, () =>
      receiveWebhook(id, { headers: req.headers, rawBody: req.rawBody ?? JSON.stringify(req.body ?? null), body: req.body, query: req.query }),
    );
  };
  const hookLimit = { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } };
  app.post('/hooks/:org/:id', hookLimit, async (req, reply) => {
    const { org, id } = z.object({ org: z.string().min(1).max(64), id: z.string().min(1).max(64) }).parse(req.params);
    return reply.code(202).send(await hook(req, org, id));
  });
  app.post('/hooks/:id', hookLimit, async (req, reply) => reply.code(202).send(await hook(req, DEFAULT_ORG, idParam.parse(req.params).id)));

  // ---- everything below: signed-in users ----
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireUser);

    scoped.get('/actions', async (req) => {
      const q = z.object({ blueprint: z.string().optional(), trigger: z.enum(['create', 'day-2', 'delete']).optional() }).parse(req.query);
      return (await listActions())
        .filter((a) => (!q.blueprint || blueprintOf(a) === q.blueprint) && (!q.trigger || (a.trigger?.type === 'form' && a.trigger.on === q.trigger)))
        .filter((a) => isAdmin(req.principal) || a.enabled)
        .map((a) => ({
          ...forViewer(a, req.principal),
          allowedForMe: a.trigger?.type === 'form' && a.trigger.on === 'create' ? canTrigger(a, req.principal, null) : undefined,
        }));
    });
    scoped.get('/actions/:id', async (req) => forViewer(await getAction(idParam.parse(req.params).id), req.principal));
    scoped.put('/actions/:id', { preHandler: requireAdmin }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { action, created } = await upsertAction(
        { ...(req.body as object), identifier: id },
        { actor: actorOf(req.principal), ifMatch: ifMatchOf(req.headers['if-match']) },
      );
      await audit(actorOf(req.principal), created ? 'action.created' : 'action.updated', id);
      return action;
    });
    /** Test a workflow without side effects: renders templates, evaluates expressions, validates invokers and secrets. */
    /** Editor helpers (admin): check/preview a JSONata expression, simulate a draft workflow on sample inputs. Nothing is executed. */
    scoped.post('/expressions/check', { preHandler: requireAdmin }, async (req) => {
      const b = z.object({ expression: z.string().max(4000), context: z.unknown().optional() }).parse(req.body);
      return previewExpression(b.expression, b.context ?? {});
    });
    scoped.post('/actions/dry-run', { preHandler: requireAdmin }, async (req) => {
      const b = z
        .object({
          steps: z.array(workflowStep).max(40),
          inputs: z.record(z.string(), z.unknown()).default({}),
          entity: z.unknown().optional(),
          vars: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(req.body);
      return { steps: await simulateWorkflow(b.steps, { inputs: b.inputs, entity: b.entity, vars: b.vars }) };
    });
    scoped.post('/actions/:id/dry-run', { preHandler: requireAdmin, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          definition: z.record(z.string(), z.unknown()).optional(),
          inputs: z.record(z.string(), z.unknown()).default({}),
          entity: z.string().nullish(),
          mock: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(req.body ?? {});
      return dryRun(id, req.principal, body);
    });
    /** Workflow tests: all of them, or `name`; `definition` tests the unsaved draft of the editor. Nothing external is called. */
    scoped.post('/actions/:id/tests/run', { preHandler: requireAdmin, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z.object({ name: z.string().max(100).optional(), definition: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {});
      return runWorkflowTests(id, req.principal, body);
    });
    scoped.get('/actions/:id/versions', { preHandler: requireAdmin }, async (req) => {
      const { id } = idParam.parse(req.params);
      await getAction(id);
      return listVersions(id);
    });
    scoped.get('/actions/:id/versions/:version', { preHandler: requireAdmin }, async (req) => {
      const { id, version } = z.object({ id: z.string().min(1).max(200), version: z.coerce.number().int().min(1) }).parse(req.params);
      return getVersion(id, version);
    });
    scoped.get('/actions/:id/diff', { preHandler: requireAdmin }, async (req) => {
      const { id } = idParam.parse(req.params);
      const q = z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }).parse(req.query);
      return diffVersions(id, q.from, q.to);
    });
    scoped.post('/actions/:id/rollback', { preHandler: requireAdmin }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { version } = z.object({ version: z.coerce.number().int().min(1) }).parse(req.body ?? {});
      const target = await getVersion(id, version);
      const { action } = await upsertAction(
        { ...target.definition, identifier: id },
        { actor: actorOf(req.principal), note: `Rollback to version ${version}` },
      );
      await audit(actorOf(req.principal), 'action.rolled_back', id, { to: version, version: action.version });
      return action;
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
        .filter((a: Action) => a.enabled && isRunnable(a) && a.trigger?.type === 'form' && a.trigger.blueprint === bp && a.trigger.on !== 'create')
        .map((a) => ({ ...forViewer(a, req.principal), allowedForMe: canTrigger(a, req.principal, e.team) }));
    });

    scoped.post('/actions/:id/runs', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          entity: z.string().nullish(),
          inputs: z.record(z.string(), z.unknown()).default({}),
          /** Admins only: start the run during a blackout window (audited). */
          overrideBlackout: z.boolean().optional(),
          priority: runPriority.optional(),
        })
        .parse(req.body ?? {});
      const key = z.string().min(1).max(200).optional().parse(req.headers['idempotency-key']);
      const { run, created } = await triggerRun(req.principal, id, body, key);
      return reply.code(created ? 201 : 200).send(run);
    });

    scoped.get('/runs', async (req, reply) => {
      const q = page
        .extend({
          mine: z.enum(['true', 'false']).optional(),
          status: z.string().optional(),
          action: z.string().optional(),
          blueprint: z.string().optional(),
          entity: z.string().optional(),
          cursor: z.string().max(500).optional(),
          count: z
            .enum(['true', 'false'])
            .transform((v) => v === 'true')
            .optional(),
        })
        .parse(req.query);
      const status = q.status ? z.array(z.enum(RUN_STATUSES)).parse(q.status.split(',')) : undefined;
      const result = await listRuns({ ...q, status, mine: q.mine === 'true' ? req.principal.id : undefined }, req.principal);
      nextPageHeaders(req, reply, result.nextCursor);
      return result;
    });
    scoped.get('/runs/:id', async (req) => {
      const q = z.object({ after: z.coerce.number().int().min(0).optional() }).parse(req.query);
      return getRun(idParam.parse(req.params).id, req.principal, q);
    });
    /**
     * Server-Sent Events for one run: `log` events carry new lines (event id = log seq, so a reconnect with
     * Last-Event-ID resumes without gaps), `run` events carry the run without logs when it changed, `done` ends the stream.
     * State is read from the database on every tick, so any replica can serve any stream.
     */
    scoped.get('/runs/:id/events', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      await getRun(id, req.principal, { logs: false }); // 404 / access check before switching to a stream
      const header = Number(req.headers['last-event-id']);
      const query = Number((req.query as { after?: string }).after);
      let cursor = Number.isFinite(header) && header > 0 ? header : Number.isFinite(query) && query > 0 ? query : 0;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let closed = false;
      req.raw.on('close', () => (closed = true));
      const send = (event: string, data: unknown, evId?: number) =>
        res.write(`${evId !== undefined ? `id: ${evId}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let lastSnapshot = '';
      const FINAL_STATUSES = ['SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED'];
      const deadline = Date.now() + 30 * 60_000;
      try {
        while (!closed && Date.now() < deadline) {
          const lines = await runLogsAfter(id, cursor);
          if (lines.length) {
            cursor = lines[lines.length - 1]!.seq;
            send('log', lines, cursor);
          }
          const run = await getRun(id, req.principal, { logs: false });
          const snap = JSON.stringify(run);
          if (snap !== lastSnapshot) {
            lastSnapshot = snap;
            send('run', run);
          }
          if (FINAL_STATUSES.includes(run.status) && !lines.length) {
            send('done', { status: run.status });
            break;
          }
          if (!lines.length) res.write(': keep-alive\n\n');
          await new Promise((r) => setTimeout(r, lines.length ? 100 : 1000));
        }
      } catch (err) {
        if (!closed) send('error', { message: (err as Error).message });
      } finally {
        res.end();
      }
    });
    scoped.get('/runs/:id/logs', async (req) => {
      const q = z
        .object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(2000).default(500), step: z.string().optional() })
        .parse(req.query);
      return getRunLogs(idParam.parse(req.params).id, req.principal, q);
    });
    /** Files attached to the run's steps (also listed in GET /runs/:id). */
    scoped.get('/runs/:id/artifacts', async (req) => {
      const { id } = idParam.parse(req.params);
      await getRun(id, req.principal, { logs: false }); // same visibility as the run
      return listArtifacts(id);
    });
    /** Download: always as an attachment, never rendered by the browser (nosniff, sandboxed). */
    scoped.get('/runs/:id/artifacts/:artifactId', async (req, reply) => {
      const { id, artifactId } = z.object({ id: z.string().min(1).max(200), artifactId: z.string().min(1).max(100) }).parse(req.params);
      await getRun(id, req.principal, { logs: false });
      const { artifact, content } = await getArtifact(id, artifactId);
      return reply
        .header('content-type', artifact.contentType)
        .header('content-disposition', contentDisposition(artifact.name))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .header('x-artifact-sha256', artifact.sha256)
        .send(content);
    });
    scoped.get('/approvals', async (req, reply) => {
      const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), cursor: z.string().max(500).optional() }).parse(req.query);
      const { items, nextCursor } = await pendingApprovals(req.principal, q);
      nextPageHeaders(req, reply, nextCursor);
      return items;
    });

    const comment = z.object({ comment: z.string().max(2000).default('') });
    scoped.post('/runs/:id/approve', async (req) => decide(req.principal, idParam.parse(req.params).id, 'approved', comment.parse(req.body ?? {}).comment));
    scoped.post('/runs/:id/reject', async (req) => decide(req.principal, idParam.parse(req.params).id, 'rejected', comment.parse(req.body ?? {}).comment));
    scoped.post('/runs/:id/cancel', async (req) => cancelRun(req.principal, idParam.parse(req.params).id, cancelSteps));
    scoped.post('/runs/:id/rerun', async (req, reply) => reply.code(201).send(await rerun(req.principal, idParam.parse(req.params).id)));
    scoped.post('/runs/:id/resume', async (req) => resume(req.principal, idParam.parse(req.params).id));
    scoped.post('/runs/:id/pause', async (req) => pauseRun(req.principal, idParam.parse(req.params).id));
    scoped.post('/runs/:id/unpause', async (req) => unpauseRun(req.principal, idParam.parse(req.params).id));
    /** Operator step control (admins): force a step to SKIPPED or SUCCESS, with a reason. */
    const forced = z.object({ comment: z.string().trim().min(1, 'Give a reason (comment)').max(2000) });
    scoped.post('/runs/:id/steps/:step/skip', { preHandler: requireAdmin }, async (req) => {
      const { id, step } = stepParams.parse(req.params);
      return forceStep(req.principal, id, step, 'skip', forced.parse(req.body ?? {}).comment);
    });
    scoped.post('/runs/:id/steps/:step/complete', { preHandler: requireAdmin }, async (req) => {
      const { id, step } = stepParams.parse(req.params);
      const b = forced.extend({ output: z.unknown().optional() }).parse(req.body ?? {});
      return forceStep(req.principal, id, step, 'complete', b.comment, b.output);
    });
    scoped.post('/runs/:id/steps/:step/retry', async (req) => {
      const { id, step } = stepParams.parse(req.params);
      return retryStep(req.principal, id, step);
    });
    const decision = comment.extend({ choice: z.string().max(100).optional(), values: z.record(z.string(), z.unknown()).optional() });
    scoped.post('/runs/:id/steps/:step/input', async (req) => {
      const { id, step } = stepParams.parse(req.params);
      await submitInput(req.principal, id, step, z.object({ values: z.record(z.string(), z.unknown()).default({}) }).parse(req.body ?? {}).values);
      return getRun(id, req.principal);
    });
    scoped.post('/runs/:id/steps/:step/approve', async (req) => {
      const { id, step } = stepParams.parse(req.params);
      const b = decision.parse(req.body ?? {});
      await decideStep(req.principal, id, step, 'approved', b.comment, { choice: b.choice, values: b.values });
      return getRun(id, req.principal);
    });
    scoped.post('/runs/:id/steps/:step/reject', async (req) => {
      const { id, step } = stepParams.parse(req.params);
      await decideStep(req.principal, id, step, 'rejected', comment.parse(req.body ?? {}).comment);
      return getRun(id, req.principal);
    });
  });
}
