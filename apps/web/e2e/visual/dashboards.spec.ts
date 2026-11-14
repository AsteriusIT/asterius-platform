import type { Page } from '@playwright/test';
import { expect, screen } from '../support/visual';

/**
 * Dashboards with trend charts: the Environment catalog page and an Environment entity page (`scope: entity`). Series
 * depend on the day the suite runs, so their data is answered here with fixed buckets and values; the layout, the
 * theme and the chart rendering are what the screenshots check.
 */

const WEEKS = ['2026-01-19', '2026-01-26', '2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23', '2026-03-02', '2026-03-09'];
const runs = (values: Record<string, number[]>) => ({
  type: 'chart',
  interval: 'week',
  buckets: WEEKS,
  unit: 'count',
  drill: { kind: 'runs' },
  series: Object.entries(values).map(([key, v]) => ({
    key,
    label: { SUCCESS: 'Succeeded', FAILURE: 'Failed', PENDING_APPROVAL: 'Waiting for approval' }[key] ?? key,
    values: v,
    filter: { scope: ['all'], status: [key] },
  })),
});

const TRENDS = [
  runs({ SUCCESS: [3, 5, 4, 6, 8, 7, 9, 6], FAILURE: [1, 0, 2, 1, 0, 1, 0, 2], PENDING_APPROVAL: [0, 1, 0, 0, 1, 0, 1, 1] }),
  {
    type: 'chart',
    interval: 'week',
    buckets: WEEKS,
    unit: 'count',
    drill: { kind: 'catalog', blueprint: 'environment' },
    series: [
      { key: 'development', label: 'development', values: [1, 1, 1, 2, 2, 2, 3, 3], filter: { f: ['type:development'] } },
      { key: 'production', label: 'production', values: [1, 1, 2, 2, 2, 2, 2, 2], filter: { f: ['type:production'] } },
      { key: 'staging', label: 'staging', values: [0, 1, 1, 1, 1, 1, 1, 2], filter: { f: ['type:staging'] } },
    ],
  },
];

async function freezeDashboard(page: Page, data: (real: unknown[]) => unknown[]) {
  await page.route(/\/api\/v1\/dashboards\/[^/]+\/data/, async (route) => {
    const real = (await (await route.fetch()).json()) as unknown[];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data(real)) });
  });
}

screen('catalog with trend charts', {}, async ({ app, page }) => {
  await freezeDashboard(page, () => TRENDS);
  await app.open('/catalog/environment');
  await expect(page.getByText('Requests by status')).toBeVisible();
  await expect(
    page
      .getByRole('img', { name: /Environments by type/ })
      .locator('svg')
      .first(),
  ).toBeVisible();
  await app.shot('catalog-trends');
});

screen('entity, dashboard overview', {}, async ({ app, page }) => {
  // Markdown and entity sections come from the server (they do not depend on the date); the chart is frozen.
  await freezeDashboard(page, (real) => [real[0], real[1], runs({ SUCCESS: [0, 1, 0, 2, 1, 0, 1, 1], FAILURE: [0, 0, 1, 0, 0, 0, 1, 0] })]);
  await app.open('/catalog/environment/prod-eu');
  await expect(page.getByText('runs in')).toBeVisible();
  await expect(
    page
      .getByRole('img', { name: /Runs on this environment/ })
      .locator('svg')
      .first(),
  ).toBeVisible();
  await app.shot('entity-dashboard');
});

screen('trend chart, table view', {}, async ({ app, page }) => {
  await freezeDashboard(page, () => TRENDS);
  await app.open('/catalog/environment');
  await page.getByRole('button', { name: 'Show as table' }).first().click();
  await expect(page.getByRole('table').first()).toBeVisible();
  await app.shot('catalog-trends-table');
});
