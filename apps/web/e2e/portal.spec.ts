import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const EMAIL = 'e2e-admin@example.com';
const PASSWORD = 'correct-horse-battery';

/** First account bootstraps the admin; later runs sign in. Returns the session token. */
async function token(request: APIRequestContext): Promise<string> {
  const reg = await request.post('/api/auth/register', { data: { email: EMAIL, name: 'E2E Admin', password: PASSWORD } });
  if (reg.ok()) return ((await reg.json()) as { token: string }).token;
  const login = await request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  return ((await login.json()) as { token: string }).token;
}

async function signIn(page: Page, request: APIRequestContext) {
  const t = await token(request);
  await page.addInitScript((value) => localStorage.setItem('asterius.token', value), t);
  return { authorization: `Bearer ${t}` };
}

test.beforeEach(async ({ request }) => {
  const headers = { authorization: `Bearer ${await token(request)}` };
  await request.put('/api/v1/blueprints/service', {
    headers,
    data: { title: 'Service', schema: { properties: { tier: { type: 'string', title: 'Tier' } } } },
  });
  for (const [id, tier] of [
    ['payments-api', 'gold'],
    ['search-api', 'silver'],
  ])
    await request.put(`/api/v1/blueprints/service/entities/${id}`, { headers, data: { properties: { tier } } });
});

test('catalog search is kept in the URL and survives a reload', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/catalog/service');
  await page.getByLabel('Search service').fill('payments');
  await expect(page).toHaveURL(/q=payments/);
  await page.reload();
  await expect(page.getByLabel('Search service')).toHaveValue('payments');
  await expect(page.getByText('payments-api')).toBeVisible();
  await expect(page.getByText('search-api')).toHaveCount(0);
});

test('catalog sorts by a property column and filters by value', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/catalog/service');
  await page.getByRole('button', { name: 'Sort by Tier' }).click();
  await expect(page).toHaveURL(/sort=tier/);
  await page.goto('/catalog/service?f=tier:silver');
  await expect(page.getByText('search-api')).toBeVisible();
  await expect(page.getByText('payments-api')).toHaveCount(0);
});

test('command palette opens with Ctrl+K and jumps to an entity', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search pages and entities').fill('payments');
  await page
    .getByRole('option', { name: /payments-api|Payments/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/catalog\/service\/payments-api/);
});

test('entity page keeps the selected tab in the URL', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto('/catalog/service/payments-api');
  await page.getByRole('tab', { name: 'Raw' }).click();
  await expect(page).toHaveURL(/tab=json/);
});
