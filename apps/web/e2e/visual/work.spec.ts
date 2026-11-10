import { expect, screen } from '../support/visual';

/** What people do every day: decisions, self-service requests, runs. */

screen('to do', { folded: true }, async ({ app, page }) => {
  await app.open('/todo');
  await expect(page.getByRole('heading', { name: 'To do' })).toBeVisible();
  await app.shot('todo');
});

screen('self-service', {}, async ({ app, page }) => {
  await app.open('/self-service');
  await expect(page.getByText('Request an environment').first()).toBeVisible();
  await app.shot('self-service');
});

screen('self-service, run dialog', {}, async ({ app, page }) => {
  await app.open('/self-service?action=register-service');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Name')).toBeVisible();
  await app.shot('self-service-run-dialog');
});

screen('runs', { folded: true }, async ({ app, page }) => {
  await app.open('/runs?scope=all');
  await expect(page.getByRole('row').nth(7)).toBeVisible();
  await app.shot('runs');
});

screen('run, graph', {}, async ({ app, page }) => {
  await app.open(`/runs/${app.seed.runs.failed}`);
  await expect(page.getByLabel('Workflow graph')).toBeVisible();
  await expect(page.getByLabel(/Move to the archive/)).toBeVisible();
  await app.shot('run-graph');
});

screen('run, all logs', {}, async ({ app, page }) => {
  await app.open(`/runs/${app.seed.runs.failed}`);
  await page.getByRole('button', { name: 'All logs' }).click();
  await expect(page.getByText('Run failed')).toBeVisible();
  await app.shot('run-logs');
});

screen('run, step waiting for an approval', {}, async ({ app, page }) => {
  await app.open(`/runs/${app.seed.runs.waitingStep}?step=approval__approve`);
  await expect(page.getByLabel('Workflow graph')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await app.shot('run-step-approval');
});
