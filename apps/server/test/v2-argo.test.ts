import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInvoker } from '../src/actions/invokers/index.js';
import { fakeServer } from './helpers.js';

const ctx = {
  run: { id: 'r-1', url: '', idempotencyKey: 'k', callback: { url: '', token: '' } },
  action: { identifier: 'a', title: 'A', blueprint: null },
  inputs: {},
  entity: null,
  trigger: { user: { id: 'u', email: 'e', name: 'n' }, at: '' },
  steps: {},
};

describe('argo-workflows one-shot operations', () => {
  let argo: Awaited<ReturnType<typeof fakeServer>>;
  beforeAll(async () => {
    argo = await fakeServer(() => ({ body: { metadata: { name: 'rerun-pipeline-x1' } } }));
  });
  afterAll(async () => {
    await argo.close();
  });

  it('submits the WorkflowTemplate with the run id as a parameter and a workflow label', async () => {
    const res = await getInvoker('argo-workflows').start({
      ctx,
      log: async () => undefined,
      config: {
        baseUrl: argo.url,
        namespace: 'argo-workflows',
        template: 'rerun-pipeline',
        token: 't',
        parameters: { run_id: 'r-1', team: 'payments', service: 'payments-api' },
        labels: { 'portal.asterius.io/run-id': 'r-1', 'portal.asterius.io/service': 'payments-api' },
      },
    });
    expect(res.status).toBe('IN_PROGRESS');
    expect(argo.received[0]!.url).toBe('/api/v1/workflows/argo-workflows/submit');
    expect(JSON.parse(argo.received[0]!.body)).toEqual({
      namespace: 'argo-workflows',
      resourceKind: 'WorkflowTemplate',
      resourceName: 'rerun-pipeline',
      submitOptions: {
        parameters: ['run_id=r-1', 'team=payments', 'service=payments-api'],
        labels: 'portal.asterius.io/run-id=r-1,portal.asterius.io/service=payments-api',
      },
    });
  });
});
