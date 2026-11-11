import { expect, screen } from '../support/visual';

/** Administration of connections and connector definitions. */

screen('connections admin', {}, async ({ app, page }) => {
  await app.open('/admin/connections');
  await expect(page.getByRole('row', { name: /CMDB production/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /CMDB production/ }).getByText('1 use')).toBeVisible();
  await app.shot('admin-connections');
});

screen('connection panel', {}, async ({ app, page }) => {
  await app.open('/admin/connections?open=cmdb-prod');
  await expect(page.getByRole('heading', { name: 'Feeds the catalog' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Service', { exact: true })).toBeVisible();
  await app.shot('admin-connection-panel');
});

screen('connection editor, authentication', {}, async ({ app, page }) => {
  await app.open('/admin/connections');
  await page
    .getByRole('row', { name: /CMDB production/ })
    .getByRole('button', { name: 'Edit' })
    .click();
  await page.getByRole('tab', { name: 'Authentication' }).click();
  await expect(page.getByText('Credentials are references, never values', { exact: false }).first()).toBeVisible();
  await app.shot('admin-connection-editor');
});

screen('new connection, connector picker', {}, async ({ app, page }) => {
  await app.open('/admin/connections');
  await expect(page.getByRole('row', { name: /CMDB production/ })).toBeVisible();
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByRole('button', { name: 'Acme CMDB' })).toBeVisible();
  await app.shot('admin-connection-picker');
});

screen('connectors admin', {}, async ({ app, page }) => {
  await app.open('/admin/connectors');
  await expect(page.getByRole('row', { name: /Acme CMDB/ })).toBeVisible();
  await app.shot('admin-connectors');
});

screen('connector definition', {}, async ({ app, page }) => {
  await app.open('/admin/connectors?open=acme-cmdb');
  await expect(page.getByRole('heading', { name: 'Operations (workflows)' })).toBeVisible();
  await app.shot('admin-connector-panel');
});

screen('connector, try an operation', {}, async ({ app, page }) => {
  await app.open('/admin/connectors?open=acme-cmdb');
  await page.getByRole('tab', { name: 'Try an operation' }).click();
  await page.getByRole('combobox', { name: 'Connection' }).click();
  await page.getByRole('option', { name: 'CMDB production' }).click();
  await page.getByLabel('Application', { exact: false }).first().fill('payments-api');
  await page.getByLabel('Summary', { exact: false }).first().fill('Deploy 2.9.0 to prod-eu');
  await page.getByRole('button', { name: 'Render the request' }).click();
  await expect(page.getByText('POST https://cmdb.acme.example/api/acme/changes')).toBeVisible();
  await app.shot('admin-connector-try');
});

screen('integration editor, through a connection', {}, async ({ app, page }) => {
  await app.open('/admin/integrations');
  await page
    .getByRole('row', { name: /CMDB applications/ })
    .getByRole('button', { name: 'Edit' })
    .click();
  await expect(page.getByText('Open CMDB production')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Kind' })).toHaveValue('Applications (application)');
  await app.shot('admin-integration-connection');
});
