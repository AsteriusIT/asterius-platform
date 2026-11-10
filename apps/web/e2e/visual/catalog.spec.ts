import { expect, screen } from '../support/visual';

/** The catalog: a blueprint's entities, and one entity. */

screen('catalog list', { folded: true }, async ({ app, page }) => {
  await app.open('/catalog/service');
  await expect(page.getByText('Payments API')).toBeVisible();
  await app.shot('catalog-list');
});

screen('catalog list, filtered, views menu', {}, async ({ app, page }) => {
  await app.open('/catalog/service?f=lifecycle:production&sort=title');
  await expect(page.getByText('Payments API')).toBeVisible();
  await page.getByRole('button', { name: /Views/ }).click();
  await expect(page.getByText('Production services')).toBeVisible();
  await app.shot('catalog-list-views');
});

screen('entity, overview', {}, async ({ app, page }) => {
  await app.open('/catalog/service/payments-api');
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('payments-oncall@acme.example')).toBeVisible();
  await app.shot('entity-overview');
});

screen('entity, history', {}, async ({ app, page }) => {
  await app.open('/catalog/service/payments-api?tab=history');
  await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  await app.shot('entity-history');
});
