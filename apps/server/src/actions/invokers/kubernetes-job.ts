import { config as platform } from '../../config.js';
import { k8s, kube } from '../../lib/kube.js';
import type { LogFn } from '../../lib/ci-logs.js';
import { requireFields, str, stringValues, type Invoker } from '../types.js';

/**
 * Run a container to completion as a Kubernetes Job (Terraform, Ansible, scripts…). The run context is passed as
 * ASTERIUS_RUN (JSON) with ASTERIUS_CALLBACK_URL / ASTERIUS_CALLBACK_TOKEN. The platform's service account needs
 * `create/get/delete jobs` and `list pods, get pods/log` in the target namespace (Helm: rbac.jobNamespaces).
 */
const MANAGED_BY = { 'app.kubernetes.io/managed-by': 'asterius-platform' };
/** Pod states that will not resolve by waiting: fail the run with Kubernetes' explanation. */
const STUCK = new Set(['CreateContainerConfigError', 'CreateContainerError', 'ErrImagePull', 'ImagePullBackOff', 'InvalidImageName']);
const jobName = (runId: string) => `asterius-run-${runId.replace(/-/g, '').slice(0, 16)}`;

/** Pod security context fields an action author may set; everything else (privileged, host*, sysctls, runAsNonRoot: false…) is refused. */
const POD_SECURITY_FIELDS = new Set(['runAsUser', 'runAsGroup', 'fsGroup', 'supplementalGroups', 'fsGroupChangePolicy', 'seccompProfile', 'runAsNonRoot']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function checkSecurityContext(sc: unknown) {
  if (sc == null) return;
  if (typeof sc !== 'object' || Array.isArray(sc)) throw new Error('kubernetes-job: securityContext must be an object');
  const c = sc as Record<string, unknown>;
  for (const k of Object.keys(c))
    if (!POD_SECURITY_FIELDS.has(k)) throw new Error(`kubernetes-job: securityContext.${k} is not allowed (allowed: ${[...POD_SECURITY_FIELDS].join(', ')})`);
  if (c.runAsNonRoot === false) throw new Error('kubernetes-job: containers must run as non-root (runAsNonRoot cannot be false)');
  if (c.runAsUser === 0 || c.runAsGroup === 0) throw new Error('kubernetes-job: runAsUser / runAsGroup 0 (root) is not allowed');
  const t = (c.seccompProfile as { type?: string } | undefined)?.type;
  if (c.seccompProfile !== undefined && t !== 'RuntimeDefault' && t !== 'Localhost')
    throw new Error('kubernetes-job: seccompProfile must be RuntimeDefault or Localhost');
}

const inList = (list: string[], v: string) => !list.length || list.includes(v);
/** Admin allow-lists (KUBE_JOB_*): where jobs may run and as which service account. */
export function checkTarget(namespace: string | undefined, serviceAccount: string | undefined, context: string | undefined) {
  if (namespace && !inList(platform.KUBE_JOB_NAMESPACES, namespace))
    throw new Error(`kubernetes-job: namespace "${namespace}" is not allowed (KUBE_JOB_NAMESPACES)`);
  if (serviceAccount && !inList(platform.KUBE_JOB_SERVICE_ACCOUNTS, serviceAccount))
    throw new Error(`kubernetes-job: service account "${serviceAccount}" is not allowed (KUBE_JOB_SERVICE_ACCOUNTS)`);
  if (context && !platform.KUBE_JOB_CONTEXTS.includes(context))
    throw new Error(`kubernetes-job: kubeconfig context "${context}" is not allowed (KUBE_JOB_CONTEXTS)`);
}
const literal = (v: unknown) => (typeof v === 'string' && v && !v.includes('{{') && !v.includes('${') ? v : undefined);

const MAX_STREAMED_LINES = 5000;
const LINES_PER_POLL = 500;

/**
 * Follow the pod log between polls: only lines newer than `state.logCursor` (an RFC 3339 timestamp from
 * `timestamps: true`) are written, up to LINES_PER_POLL per poll and MAX_STREAMED_LINES overall.
 */
async function streamLogs(k: ReturnType<typeof kube>, state: Record<string, unknown>, pod: string | undefined, log: LogFn, final = false) {
  if (!pod) return state;
  const sent = Number(state.logLines ?? 0);
  if (sent >= MAX_STREAMED_LINES) return state;
  try {
    const cursor = typeof state.logCursor === 'string' ? state.logCursor : undefined;
    const out = String(
      await k.core.readNamespacedPodLog({
        name: pod,
        namespace: str(state.namespace),
        timestamps: true,
        ...(cursor ? { sinceTime: new Date(cursor) } : { tailLines: final ? 200 : LINES_PER_POLL }),
      }),
    );
    const fresh = out
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ ts: l.slice(0, l.indexOf(' ')), text: l.slice(l.indexOf(' ') + 1) }))
      .filter((l) => !cursor || l.ts > cursor)
      .slice(0, LINES_PER_POLL);
    for (const l of fresh) await log(l.text.length > 1000 ? `${l.text.slice(0, 1000)}…` : l.text);
    if (!fresh.length) return state;
    return { ...state, logCursor: fresh.at(-1)!.ts, logLines: sent + fresh.length };
  } catch (err) {
    await log(`Could not read job logs: ${(err as Error).message}`, 'warn');
    return state;
  }
}

export const kubernetesJobInvoker: Invoker = {
  info: {
    type: 'kubernetes-job',
    title: 'Kubernetes Job',
    description: 'Run a container to completion in a cluster namespace and collect its logs.',
    fields: [
      { key: 'namespace', label: 'Namespace', kind: 'text', required: true },
      { key: 'image', label: 'Image', kind: 'text', required: true, placeholder: 'ghcr.io/my-org/runner:1.0' },
      { key: 'command', label: 'Command', kind: 'list' },
      { key: 'args', label: 'Arguments', kind: 'list' },
      { key: 'env', label: 'Environment variables', kind: 'keyvalue', help: 'ASTERIUS_RUN, ASTERIUS_CALLBACK_URL and ASTERIUS_CALLBACK_TOKEN are always set' },
      { key: 'serviceAccountName', label: 'Service account', kind: 'text', advanced: true },
      { key: 'securityContext', label: 'Pod security context', kind: 'json', help: 'Non-root by default; e.g. { "runAsUser": 65534 }', advanced: true },
      { key: 'activeDeadlineSeconds', label: 'Timeout (seconds)', kind: 'number', placeholder: '3600', advanced: true },
      { key: 'resources', label: 'Resources', kind: 'json', advanced: true },
      { key: 'context', label: 'Kubeconfig context', kind: 'text', help: 'Another cluster of the kubeconfig', advanced: true },
    ],
    example: {
      type: 'kubernetes-job',
      namespace: 'platform-jobs',
      image: 'ghcr.io/my-org/terraform-runner:1.4.0',
      args: ['apply', '--module', '{{ inputs.module }}'],
      env: { SERVICE: '{{ entity.identifier }}' },
      serviceAccountName: 'terraform-runner',
      activeDeadlineSeconds: 3600,
      securityContext: { runAsUser: 10001 },
    },
  },
  validate(c) {
    requireFields(c, ['namespace', 'image'], 'kubernetes-job');
    checkSecurityContext(c.securityContext);
    // Templated values are checked again when the job starts.
    checkTarget(literal(c.namespace), literal(c.serviceAccountName), literal(c.context));
  },
  async start({ ctx, config, log }) {
    const name = jobName(ctx.run.id);
    const namespace = str(config.namespace);
    const serviceAccount = config.serviceAccountName ? str(config.serviceAccountName) : undefined;
    const context = config.context ? str(config.context) : undefined;
    checkTarget(namespace, serviceAccount, context);
    checkSecurityContext(config.securityContext);
    // Rendered secrets and the callback token never go in the Job spec (readable by anyone who can `get jobs`):
    // they live in a per-run Secret, referenced with envFrom and garbage-collected with the Job.
    const vars = {
      ...stringValues(config.env),
      ASTERIUS_RUN: JSON.stringify({ ...ctx, run: { id: ctx.run.id, url: ctx.run.url } }),
      ASTERIUS_CALLBACK_URL: ctx.run.callback.url,
      ASTERIUS_CALLBACK_TOKEN: ctx.run.callback.token,
    };
    for (const n of Object.keys(vars)) if (!ENV_NAME.test(n)) throw new Error(`kubernetes-job: invalid environment variable name "${n}"`);
    const job: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name, namespace, labels: { ...MANAGED_BY, 'asterius.io/run-id': ctx.run.id }, annotations: { 'asterius.io/action': ctx.action.identifier } },
      spec: {
        backoffLimit: Number(config.backoffLimit ?? 0),
        activeDeadlineSeconds: Number(config.activeDeadlineSeconds ?? 3600),
        ttlSecondsAfterFinished: Number(config.ttlSecondsAfterFinished ?? 86400),
        template: {
          metadata: { labels: { ...MANAGED_BY, 'asterius.io/run-id': ctx.run.id } },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: serviceAccount,
            automountServiceAccountToken: !!config.serviceAccountName,
            // Hardened by default; images that run as root need e.g. `securityContext: { runAsUser: 65534 }`.
            securityContext: {
              seccompProfile: { type: 'RuntimeDefault' },
              ...((config.securityContext as k8s.V1PodSecurityContext) ?? {}),
              runAsNonRoot: true, // not overridable
            },
            containers: [
              {
                name: 'run',
                image: str(config.image),
                command: Array.isArray(config.command) ? config.command.map(str) : undefined,
                args: Array.isArray(config.args) ? config.args.map(str) : undefined,
                envFrom: [{ secretRef: { name } }],
                resources: (config.resources as k8s.V1ResourceRequirements) ?? { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '1Gi' } },
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
              },
            ],
          },
        },
      },
    };
    const k = kube(context);
    const secret: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace, labels: { ...MANAGED_BY, 'asterius.io/run-id': ctx.run.id } },
      type: 'Opaque',
      stringData: vars,
    };
    await k.core.createNamespacedSecret({ namespace, body: secret });
    try {
      const created = await k.batch.createNamespacedJob({ namespace, body: job });
      // The Secret is deleted with the Job (TTL, cancel, failure cleanup).
      await k.core.patchNamespacedSecret(
        { name, namespace, body: { metadata: { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name, uid: created.metadata!.uid! }] } } },
        k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
      );
    } catch (err) {
      await k.core.deleteNamespacedSecret({ name, namespace }).catch(() => undefined);
      throw err;
    }
    await log(`Job ${namespace}/${name} created (${config.image})`);
    return { status: 'IN_PROGRESS', state: { name, namespace }, statusLabel: 'job created' };
  },
  async poll({ config, log }, state) {
    const k = kube(config.context ? str(config.context) : undefined);
    const job = await k.batch.readNamespacedJob({ name: str(state.name), namespace: str(state.namespace) });
    const done = job.status?.succeeded ? 'SUCCESS' : job.status?.conditions?.some((c) => c.type === 'Failed' && c.status === 'True') ? 'FAILURE' : null;
    if (!done) {
      const pods = await k.core.listNamespacedPod({ namespace: str(state.namespace), labelSelector: `job-name=${state.name}` });
      const waiting = pods.items.flatMap((p) => p.status?.containerStatuses ?? []).find((c) => c.state?.waiting && STUCK.has(c.state.waiting.reason ?? ''));
      if (waiting) {
        await log(`${waiting.state!.waiting!.reason}: ${waiting.state!.waiting!.message ?? ''}`, 'error');
        await k.batch.deleteNamespacedJob({ name: str(state.name), namespace: str(state.namespace), propagationPolicy: 'Background' }).catch(() => undefined);
        return { status: 'FAILURE', state, statusLabel: waiting.state!.waiting!.reason };
      }
      const running = pods.items.some((p) => p.status?.phase === 'Running');
      const next = running ? await streamLogs(k, state, pods.items.at(-1)?.metadata?.name, log) : state;
      return { status: 'IN_PROGRESS', state: next, statusLabel: running ? 'running' : 'pending' };
    }
    try {
      const pods = await k.core.listNamespacedPod({ namespace: str(state.namespace), labelSelector: `job-name=${state.name}` });
      const pod = pods.items.at(-1)?.metadata?.name;
      if (pod) {
        // Whatever was not streamed yet (or the tail, if streaming never started).
        await streamLogs(k, state, pod, log, true);
      }
    } catch (err) {
      await log(`Could not read job logs: ${(err as Error).message}`, 'warn');
    }
    return { status: done, state, statusLabel: done === 'SUCCESS' ? 'succeeded' : 'failed' };
  },
  async cancel({ config }, state) {
    await kube(config.context ? str(config.context) : undefined).batch.deleteNamespacedJob({
      name: str(state.name),
      namespace: str(state.namespace),
      propagationPolicy: 'Background',
    });
  },
};
