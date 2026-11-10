import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Functional tests. They work in their own organization (`e2e`), next to the one the visual tests read (`acme`,
 * seeded by support/seed.ts), so what they write never shows up in a screenshot.
 */
const EMAIL = 'e2e-admin@example.com';
const PASSWORD = 'correct-horse-battery';
const ORG = 'e2e';

let session: string | undefined;

/** The account is created on the first call (later calls and later runs sign in); one session per worker. */
async function token(request: APIRequestContext): Promise<string> {
  if (session) return session;
  const reg = await request.post('/api/auth/register', { data: { email: EMAIL, name: 'E2E Admin', password: PASSWORD } });
  const res = reg.ok() ? reg : await request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  expect(res.ok(), `sign-in: ${res.status()}`).toBeTruthy();
  session = ((await res.json()) as { token: string }).token;
  // No onboarding tour over the pages (it opens on a user's first visit and takes the clicks).
  await request.put('/api/auth/me/tour', { headers: { authorization: `Bearer ${session}` }, data: { completed: true } });
  return session;
}

/** Headers of an API call in the test organization. */
async function api(request: APIRequestContext) {
  return { authorization: `Bearer ${await token(request)}`, 'x-asterius-org': ORG };
}

async function signIn(page: Page, request: APIRequestContext) {
  const t = await token(request);
  await page.addInitScript((value) => localStorage.setItem('asterius.token', value), t);
}

test.beforeEach(async ({ request }) => {
  // The API needs an organization: the account creates its own (it becomes its admin). 409: it exists already.
  const created = await request.post('/api/orgs', { headers: { authorization: `Bearer ${await token(request)}` }, data: { slug: ORG, name: 'E2E' } });
  expect([201, 409]).toContain(created.status());
  const headers = await api(request);
  const blueprint = await request.put('/api/v1/blueprints/service', {
    headers,
    data: { title: 'Service', schema: { properties: { tier: { type: 'string', title: 'Tier' } } } },
  });
  expect(blueprint.ok()).toBeTruthy();
  for (const [id, tier] of [
    ['payments-api', 'gold'],
    ['search-api', 'silver'],
  ]) {
    const entity = await request.put(`/api/v1/blueprints/service/entities/${id}`, { headers, data: { properties: { tier } } });
    expect(entity.ok()).toBeTruthy();
  }
});

test('catalog search is kept in the URL and survives a reload', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto(`/o/${ORG}/catalog/service`);
  await page.getByLabel('Search service').fill('payments');
  await expect(page).toHaveURL(/q=payments/);
  await page.reload();
  await expect(page.getByLabel('Search service')).toHaveValue('payments');
  await expect(page.getByText('payments-api')).toBeVisible();
  await expect(page.getByText('search-api')).toHaveCount(0);
});

test('catalog sorts by a property column and filters by value', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto(`/o/${ORG}/catalog/service`);
  await page.getByRole('button', { name: 'Sort by Tier' }).click();
  await expect(page).toHaveURL(/sort=tier/);
  await page.goto(`/o/${ORG}/catalog/service?f=tier:silver`);
  await expect(page.getByText('search-api')).toBeVisible();
  await expect(page.getByText('payments-api')).toHaveCount(0);
});

test('command palette opens with Ctrl+K and jumps to an entity', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto(`/o/${ORG}/`);
  // The shortcut is the shell's: wait for it (a key pressed while the app loads is lost).
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search pages and entities').fill('payments');
  await page
    .getByRole('option', { name: /payments-api|Payments/i })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/o/${ORG}/catalog/service/payments-api`));
});

test('entity page keeps the selected tab in the URL', async ({ page, request }) => {
  await signIn(page, request);
  await page.goto(`/o/${ORG}/catalog/service/payments-api`);
  await page.getByRole('tab', { name: 'Raw' }).click();
  await expect(page).toHaveURL(/tab=json/);
});

test('a legacy URL without the organization moves under /o/<slug>', async ({ page, request }) => {
  await signIn(page, request);
  await page.addInitScript((slug) => localStorage.setItem('asterius.org', slug), ORG);
  await page.goto('/catalog/service/payments-api?tab=json');
  await expect(page).toHaveURL(new RegExp(`/o/${ORG}/catalog/service/payments-api\\?tab=json`));
  await expect(page.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
});
