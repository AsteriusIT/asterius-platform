import { kube, k8s } from '../../lib/kube.js';
import { orgId } from '../../orgs/context.js';
import { assertKubernetesAllowed } from '../../orgs/orgs.js';
import { requireFields, str, stringValues, type InvokeResult, type Invoker } from '../types.js';

/**
 * Tekton PipelineRun: creates a run of an existing Pipeline and follows its `Succeeded` condition. The platform's
 * service account needs create/get/patch on `pipelineruns.tekton.dev` in the namespace.
 */
const API = 'tekton.dev/v1';
const runName = (runId: string) => `asterius-${runId.replace(/-/g, '').slice(0, 16)}`;
const ref = (namespace: string, name: string) => ({ apiVersion: API, kind: 'PipelineRun', metadata: { name, namespace } });

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export function fromConditions(conditions: Condition[] | undefined): { status: InvokeResult['status']; label: string; message?: string } {
  const c = conditions?.find((x) => x.type === 'Succeeded');
  if (!c || c.status === 'Unknown') return { status: 'IN_PROGRESS', label: c?.reason ?? 'Pending' };
  return { status: c.status === 'True' ? 'SUCCESS' : 'FAILURE', label: c.reason ?? (c.status === 'True' ? 'Succeeded' : 'Failed'), message: c.message };
}

export const tektonInvoker: Invoker = {
  info: {
    type: 'tekton',
    title: 'Tekton pipeline',
    description: 'Create a Tekton PipelineRun with parameters and follow it.',
    fields: [
      { key: 'pipeline', label: 'Pipeline', kind: 'text', required: true },
      { key: 'namespace', label: 'Namespace', kind: 'text', placeholder: 'tekton-pipelines' },
      { key: 'params', label: 'Parameters', kind: 'keyvalue' },
      { key: 'serviceAccountName', label: 'Service account', kind: 'text', advanced: true },
      { key: 'context', label: 'Kubeconfig context', kind: 'text', advanced: true },
    ],
    example: { type: 'tekton', pipeline: 'build-and-deploy', namespace: 'ci', params: { service: '{{ entity.identifier }}', version: '{{ inputs.version }}' } },
  },
  validate: (c) => requireFields(c, ['pipeline'], 'tekton'),
  async start({ config, ctx, log }) {
    await assertKubernetesAllowed(orgId()); // the platform's cluster credentials (KUBERNETES_ORGS)
    const namespace = str(config.namespace || 'default');
    const name = runName(ctx.run.id);
    const body = {
      ...ref(namespace, name),
      metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'asterius-platform', 'asterius.io/run-id': ctx.run.id } },
      spec: {
        pipelineRef: { name: str(config.pipeline) },
        params: Object.entries(stringValues(config.params)).map(([n, value]) => ({ name: n, value })),
        ...(config.serviceAccountName ? { taskRunTemplate: { serviceAccountName: str(config.serviceAccountName) } } : {}),
      },
    };
    await kube(config.context ? str(config.context) : undefined).objects.create(body);
    await log(`PipelineRun ${namespace}/${name} created`);
    return { status: 'IN_PROGRESS', state: { name, namespace }, statusLabel: 'Pending' };
  },
  async poll({ config, log }, state): Promise<InvokeResult> {
    await assertKubernetesAllowed(orgId()); // the platform's cluster credentials (KUBERNETES_ORGS)
    const k = kube(config.context ? str(config.context) : undefined);
    const pr = (await k.objects.read(ref(str(state.namespace), str(state.name)))) as { status?: { conditions?: Condition[] } };
    const r = fromConditions(pr.status?.conditions);
    if (r.status === 'FAILURE') await log(r.message ?? r.label, 'error');
    return { status: r.status, state, statusLabel: r.label };
  },
  async cancel({ config }, state) {
    await assertKubernetesAllowed(orgId()); // the platform's cluster credentials (KUBERNETES_ORGS)
    const k = kube(config.context ? str(config.context) : undefined);
    await k.objects.patch(
      { ...ref(str(state.namespace), str(state.name)), spec: { status: 'Cancelled' } } as k8s.KubernetesObject,
      undefined,
      undefined,
      undefined,
      undefined,
      k8s.PatchStrategy.MergePatch,
    );
  },
};
