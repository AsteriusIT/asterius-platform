import { kube, type k8s } from '../../lib/kube.js';
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
  validate: (c) => requireFields(c, ['namespace', 'image'], 'kubernetes-job'),
  async start({ ctx, config, log }) {
    const name = jobName(ctx.run.id);
    const namespace = str(config.namespace);
    const env = Object.entries({
      ...stringValues(config.env),
      ASTERIUS_RUN: JSON.stringify({ ...ctx, run: { id: ctx.run.id, url: ctx.run.url } }),
      ASTERIUS_CALLBACK_URL: ctx.run.callback.url,
      ASTERIUS_CALLBACK_TOKEN: ctx.run.callback.token,
    }).map(([n, value]) => ({ name: n, value }));
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
            serviceAccountName: config.serviceAccountName ? str(config.serviceAccountName) : undefined,
            automountServiceAccountToken: !!config.serviceAccountName,
            // Hardened by default; images that run as root need e.g. `securityContext: { runAsUser: 65534 }`.
            securityContext: {
              runAsNonRoot: true,
              seccompProfile: { type: 'RuntimeDefault' },
              ...((config.securityContext as k8s.V1PodSecurityContext) ?? {}),
            },
            containers: [
              {
                name: 'run',
                image: str(config.image),
                command: Array.isArray(config.command) ? config.command.map(str) : undefined,
                args: Array.isArray(config.args) ? config.args.map(str) : undefined,
                env,
                resources: (config.resources as k8s.V1ResourceRequirements) ?? { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '1Gi' } },
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
              },
            ],
          },
        },
      },
    };
    await kube(config.context ? str(config.context) : undefined).batch.createNamespacedJob({ namespace, body: job });
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
      return { status: 'IN_PROGRESS', state, statusLabel: running ? 'running' : 'pending' };
    }
    try {
      const pods = await k.core.listNamespacedPod({ namespace: str(state.namespace), labelSelector: `job-name=${state.name}` });
      const pod = pods.items.at(-1)?.metadata?.name;
      if (pod) {
        const out = await k.core.readNamespacedPodLog({ name: pod, namespace: str(state.namespace), tailLines: 200 });
        for (const line of String(out).split('\n').filter(Boolean)) await log(line);
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
