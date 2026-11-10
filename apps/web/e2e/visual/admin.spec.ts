import { expect, screen } from '../support/visual';

/** Administration: the workflow editor, a definition list and its editor, access. */

screen('workflow editor', {}, async ({ app, page }) => {
  await app.open('/admin/actions/deploy-service');
  await expect(page.getByLabel('Workflow graph')).toBeVisible();
  await expect(page.getByLabel(/Record the deployment/).first()).toBeVisible();
  await app.shot('workflow-editor');
});

screen('workflow editor, step dialog', {}, async ({ app, page }) => {
  await app.open('/admin/actions/deploy-service');
  await page
    .getByLabel(/Record the deployment/)
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await app.shot('workflow-editor-step');
});

screen('blueprints admin', { folded: true }, async ({ app, page }) => {
  await app.open('/admin/blueprints');
  await expect(page.getByRole('row').nth(3)).toBeVisible();
  await app.shot('admin-blueprints');
});

screen('blueprints admin, editor', {}, async ({ app, page }) => {
  await app.open('/admin/blueprints');
  await page
    .getByRole('row', { name: /Service/ })
    .getByRole('button', { name: 'Edit' })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await app.shot('admin-blueprint-editor');
});

screen('users admin', {}, async ({ app, page }) => {
  await app.open('/admin/users');
  await expect(page.getByText('grace@acme.example')).toBeVisible();
  await app.shot('admin-users');
});

screen('teams admin', {}, async ({ app, page }) => {
  await app.open('/admin/teams');
  await expect(page.getByRole('row').nth(3)).toBeVisible();
  await app.shot('admin-teams');
});
