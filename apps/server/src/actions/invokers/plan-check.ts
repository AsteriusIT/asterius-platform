import type { PlanSeverity } from '@asterius/shared';
import { one } from '../../db.js';
import { notify } from '../../inbox.js';
import { http } from '../../lib/http.js';
import { checkExpression } from '../../lib/expr.js';
import { planPolicies } from '../../policies/policies.js';
import { getArtifact } from '../artifacts.js';
import { buildOutput, runChecks, SEVERITIES, type OpaConfig, type Rule } from '../../plan/checks.js';
import { parsePlan } from '../../plan/plan.js';
import { catalogChain } from '../../plan/price-catalogs.js';
import { estimate } from '../../plan/pricing.js';
import { adoAuth, adoBase } from './ado.js';
import { str, type InvokeEnv, type Invoker } from '../types.js';

/**
 * `plan-check`: cost, carbon and policy checks of a Terraform / OpenTofu plan before anything is applied.
 * The plan (`terraform show -json`) comes from an earlier step: its output (`plan`), a run artifact (`planArtifact`),
 * a URL (`planUrl`) or a build artifact of an Azure DevOps run (`ado`). Critical findings fail the step; warnings set
 * `requiresOverride` (an approval step reads it); advisories are logged and notified to the requester.
 */

const PLAN_MAX_BYTES = 25 * 1024 * 1024;
const SOURCES = ['plan', 'planArtifact', 'planUrl', 'ado'] as const;

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const sizeCheck = (text: string) => {
  if (Buffer.byteLength(text) > PLAN_MAX_BYTES) throw new Error(`The plan is larger than ${PLAN_MAX_BYTES / 1024 / 1024} MB`);
  return text;
};

/** `{ step, name }` (the newest artifact with that name, of that step or any step) or an artifact id, of this run. */
async function fromArtifact(runId: string, ref: unknown): Promise<string> {
  const o = obj(ref);
  let id = typeof ref === 'string' ? ref : undefined;
  if (o) {
    const name = str(o.name) || 'plan.json';
    const row = await one<{ id: string }>(
      `SELECT id FROM run_artifacts WHERE run_id = ? AND name = ?${o.step ? ' AND step_id = ?' : ''} ORDER BY created_at DESC, id DESC`,
      ...[runId, name, ...(o.step ? [str(o.step)] : [])],
    );
    if (!row) throw new Error(`No artifact "${name}"${o.step ? ` on step ${str(o.step)}` : ''} in this run (did the plan stage upload plan.json?)`);
    id = row.id;
  }
  if (!id) throw new Error('planArtifact: { step, name } or an artifact id');
  return getArtifact(runId, id).then((a) => sizeCheck(a.content.toString('utf8')));
}

/** One file of a build artifact of an Azure DevOps run (the pipeline publishes plan.json, e.g. artifact `plan`). */
async function fromAdo(c: Record<string, unknown>): Promise<string> {
  const buildId = str(c.buildId ?? c.runId);
  if (!/^\d+$/.test(buildId)) throw new Error('ado.buildId: the run id of the plan pipeline (e.g. {{ steps.tfplan.output.runId }})');
  const artifact = str(c.artifact) || 'plan';
  const file = (str(c.file) || 'plan.json').replace(/^\/+/, '');
  const meta = await http<{ resource?: { downloadUrl?: string } }>(
    `${adoBase(c)}/_apis/build/builds/${buildId}/artifacts?artifactName=${encodeURIComponent(artifact)}&api-version=7.1`,
    { headers: adoAuth(c) },
  );
  const download = meta.data.resource?.downloadUrl;
  if (!download) throw new Error(`Azure DevOps run ${buildId} has no artifact "${artifact}"`);
  const u = new URL(download);
  u.searchParams.set('$format', 'file');
  u.searchParams.set('subPath', `/${file}`);
  // The credential only goes to the organization's own host or Azure DevOps' artifact hosts.
  const trusted = u.origin === new URL(adoBase(c)).origin || /(^|\.)(dev\.azure\.com|visualstudio\.com)$/i.test(u.hostname);
  const res = await http<unknown>(u.toString(), { headers: { ...(trusted ? adoAuth(c) : {}), accept: 'application/json, application/octet-stream' } });
  return sizeCheck(typeof res.data === 'string' ? res.data : JSON.stringify(res.data));
}

async function loadPlan(env: InvokeEnv): Promise<{ plan: unknown; from: string }> {
  const c = env.config;
  if (c.plan !== undefined && c.plan !== '' && c.plan !== null) return { plan: c.plan, from: 'the step configuration' };
  if (c.planArtifact) return { plan: await fromArtifact(env.ctx.run.id, c.planArtifact), from: 'a run artifact' };
  if (c.planUrl) {
    const res = await http<unknown>(str(c.planUrl), { headers: obj(c.headers) as Record<string, string> | undefined });
    return { plan: typeof res.data === 'string' ? sizeCheck(res.data) : res.data, from: new URL(str(c.planUrl)).host };
  }
  if (obj(c.ado)) return { plan: await fromAdo(obj(c.ado)!), from: 'an Azure DevOps artifact' };
  throw new Error('plan-check: no plan (set plan, planArtifact, planUrl or ado)');
}

const severity = (v: unknown, d: PlanSeverity): PlanSeverity => (SEVERITIES.includes(v as PlanSeverity) ? (v as PlanSeverity) : d);

function rulesOf(c: Record<string, unknown>): Rule[] {
  const list = Array.isArray(c.policies) ? c.policies : [];
  return list.map((r, i) => {
    const o = obj(r) ?? {};
    return {
      id: str(o.id) || `rule-${i + 1}`,
      title: str(o.title) || undefined,
      severity: severity(o.severity, 'critical'),
      expression: str(o.expression),
      message: str(o.message) || undefined,
    };
  });
}

export const planCheckInvoker: Invoker = {
  info: {
    type: 'plan-check',
    title: 'Plan check (cost, carbon, policies)',
    description:
      'Estimate the monthly cost and carbon of a Terraform / OpenTofu plan (terraform show -json) and evaluate plan policies (JSONata, OPA). Critical findings fail the step, warnings set output.requiresOverride for an approval, advisories are notified. Output: { gate, requiresOverride, cost: { monthly, delta, currency, unmatched }, carbon, violations, counts, resources, summary }.',
    fields: [
      {
        key: 'plan',
        label: 'Plan (JSON)',
        kind: 'text',
        placeholder: '{{ steps.tfplan.output.plan }}',
        help: 'The plan object or JSON text from an earlier step',
      },
      {
        key: 'planArtifact',
        label: 'Plan run artifact ({ step, name })',
        kind: 'json',
        help: 'A file attached to this run, e.g. { "step": "tfplan", "name": "plan.json" }',
      },
      { key: 'planUrl', label: 'Plan URL', kind: 'text', advanced: true },
      { key: 'headers', label: 'Plan URL headers', kind: 'keyvalue', advanced: true },
      {
        key: 'ado',
        label: 'Azure DevOps artifact ({ organization, project, token, buildId, artifact, file })',
        kind: 'json',
        advanced: true,
        help: 'plan.json published by an Azure Pipelines run',
      },
      { key: 'priceCatalog', label: 'Price catalog', kind: 'text', placeholder: 'default', help: 'Default: the catalog "default", else the built-in sample' },
      { key: 'budget', label: 'Budget ({ maxMonthly, maxDelta, severity })', kind: 'json' },
      { key: 'policies', label: 'Step rules ([{ id, severity, expression, message }])', kind: 'json', help: 'In addition to the organization plan policies' },
      { key: 'opa', label: 'OPA ({ url, path, headers, severity, input })', kind: 'json', advanced: true },
      { key: 'onWarning', label: 'Warnings', kind: 'select', options: ['override', 'fail', 'ignore'], help: 'override: requiresOverride for an approval step' },
      { key: 'unpriced', label: 'Resources without a price', kind: 'select', options: ['advisory', 'warning', 'critical', 'ignore'], advanced: true },
      { key: 'notify', label: 'Notify the requester of advisories', kind: 'boolean', advanced: true },
      { key: 'maxResources', label: 'Resources kept in the output', kind: 'number', advanced: true },
    ],
    example: {
      type: 'plan-check',
      planArtifact: { step: 'tfplan', name: 'plan.json' },
      budget: { maxDelta: 500, severity: 'warning' },
      policies: [
        {
          id: 'no-db-destroy',
          severity: 'critical',
          expression: '[changes[action in ["delete", "replace"] and type in ["azurerm_mssql_database", "aws_db_instance"]].address]',
          message: 'Databases cannot be destroyed from self-service',
        },
        {
          id: 'tags',
          severity: 'advisory',
          expression: '[changes[action = "create" and $exists(after.tags) and $not($exists(after.tags.costCenter))].address]',
          message: 'Missing costCenter tag',
        },
      ],
      onWarning: 'override',
    },
  },
  validate(c) {
    const given = SOURCES.filter((k) => c[k] !== undefined && c[k] !== '' && c[k] !== null);
    if (given.length !== 1) throw new Error(`plan-check invoker: set exactly one of ${SOURCES.join(', ')}`);
    if (c.onWarning !== undefined && !['override', 'fail', 'ignore'].includes(str(c.onWarning)))
      throw new Error('plan-check invoker: onWarning is override, fail or ignore');
    if (c.unpriced !== undefined && ![...SEVERITIES, 'ignore'].includes(str(c.unpriced)))
      throw new Error('plan-check invoker: unpriced is critical, warning, advisory or ignore');
    if (c.policies !== undefined) {
      if (!Array.isArray(c.policies)) throw new Error('plan-check invoker: policies is a list of { id, severity, expression, message }');
      for (const r of c.policies as unknown[]) {
        const o = obj(r);
        if (!o || typeof o.expression !== 'string' || !o.expression.trim()) throw new Error('plan-check invoker: every rule needs an expression');
        if (o.severity !== undefined && !SEVERITIES.includes(o.severity as PlanSeverity))
          throw new Error(`plan-check invoker: rule severity is ${SEVERITIES.join(', ')}`);
        checkExpression(o.expression);
      }
    }
    const opa = c.opa === undefined ? undefined : obj(c.opa);
    if (c.opa !== undefined && (!opa || !opa.url || !opa.path)) throw new Error('plan-check invoker: opa needs url and path');
    const b = c.budget === undefined ? undefined : obj(c.budget);
    if (c.budget !== undefined && (!b || (b.maxMonthly === undefined && b.maxDelta === undefined)))
      throw new Error('plan-check invoker: budget needs maxMonthly or maxDelta');
  },
  async start(env) {
    const { config: c, ctx, log } = env;
    const { plan: raw, from } = await loadPlan(env);
    const plan = parsePlan(raw);
    const chain = await catalogChain(str(c.priceCatalog) || null);
    const est = estimate(plan, chain);
    await log(
      `Plan read from ${from}${plan.terraformVersion ? ` (Terraform/OpenTofu ${plan.terraformVersion})` : ''}: ${plan.resources.length} resource(s), price catalog ${chain.map((x) => x.identifier).join(' → ')}`,
    );
    const opa = obj(c.opa) as OpaConfig | undefined;
    const b = obj(c.budget);
    const violations = await runChecks(plan, est, {
      rules: rulesOf(c),
      policies: await planPolicies(ctx.action.identifier),
      opa: opa ? { ...opa, severity: severity(opa.severity, 'critical') } : undefined,
      budget: b
        ? { maxMonthly: b.maxMonthly as number | undefined, maxDelta: b.maxDelta as number | undefined, severity: severity(b.severity, 'warning') }
        : undefined,
      unpriced: c.unpriced === 'ignore' ? 'ignore' : severity(c.unpriced, 'advisory'),
      context: { inputs: ctx.inputs, action: ctx.action, principal: ctx.trigger.user, entity: ctx.entity },
    });
    const onWarning = (['override', 'fail', 'ignore'].includes(str(c.onWarning)) ? str(c.onWarning) : 'override') as 'override' | 'fail' | 'ignore';
    const maxResources = Math.min(Math.max(Number(c.maxResources) || 50, 0), 500);
    const output = buildOutput(plan, est, violations, { onWarning, maxResources });
    const money = (n: number) => `${n.toFixed(2)} ${est.currency}`;
    await log(
      `Estimated cost ${money(est.monthly)}/month (${est.delta >= 0 ? '+' : ''}${money(est.delta)}), carbon ${est.carbon.monthlyKg.toFixed(1)} kgCO2e/month (estimate)${est.unmatched.length ? `; ${est.unmatched.length} resource(s) without a price: ${est.unmatched.slice(0, 10).join(', ')}` : ''}`,
      est.unmatched.length ? 'warn' : 'info',
    );
    for (const v of violations)
      await log(`[${v.severity}] ${v.title}: ${v.message}`, v.severity === 'critical' ? 'error' : v.severity === 'warning' ? 'warn' : 'info');
    const advisories = violations.filter((v) => v.severity === 'advisory');
    if (advisories.length && c.notify !== false)
      await notify(ctx.trigger.user.id, {
        kind: 'plan-check.advisory',
        title: `${ctx.action.title}: ${advisories.length} advisory plan finding(s)`,
        body: advisories
          .slice(0, 5)
          .map((v) => `${v.title}: ${v.message}`)
          .join('\n'),
        link: `/runs/${ctx.run.id}`,
        dedupe: `plan-check:${ctx.run.idempotencyKey}`,
      }).catch(() => undefined);
    // The full report (every resource) as an artifact; the step output keeps the first `maxResources`.
    const artifacts =
      c.report === false
        ? []
        : [
            {
              name: 'plan-check.json',
              contentType: 'application/json',
              content: Buffer.from(JSON.stringify({ ...output, resources: est.resources, truncated: 0 }, null, 2)).toString('base64'),
            },
          ];
    const label = `${money(est.monthly)}/month (${est.delta >= 0 ? '+' : ''}${money(est.delta)})`;
    if (output.gate === 'blocked') {
      const first = violations.find((v) => v.severity === 'critical') ?? violations.find((v) => v.severity === 'warning');
      return {
        status: 'FAILURE',
        result: output,
        artifacts,
        statusLabel:
          `Blocked: ${output.counts.critical} critical${onWarning === 'fail' && output.counts.warning ? `, ${output.counts.warning} warning` : ''} finding(s)${first ? ` — ${first.title}: ${first.message}` : ''}`.slice(
            0,
            200,
          ),
      };
    }
    return {
      status: 'SUCCESS',
      result: output,
      artifacts,
      statusLabel: output.gate === 'override' ? `${label} · ${output.counts.warning} warning(s): override required` : label,
    };
  },
};
