import { expect, MOBILE, screen } from '../support/visual';

/** The application shell: home, navigation, notifications, command palette, and the pages outside it. */

screen('home', { folded: true }, async ({ app, page }) => {
  await app.open('/');
  await expect(page.getByRole('heading', { name: 'Hello Ada' })).toBeVisible();
  await expect(page.getByText('Recently changed in the catalog')).toBeVisible();
  await app.shot('home');
});

screen('home on a phone, navigation open', { viewport: MOBILE }, async ({ app, page }) => {
  await app.open('/');
  await expect(page.getByRole('heading', { name: 'Hello Ada' })).toBeVisible();
  await page.locator('.mantine-Burger-root').click();
  await expect(page.getByRole('link', { name: 'Self-service' })).toBeVisible();
  await app.shot('home-mobile-nav');
});

screen('notifications panel', {}, async ({ app, page }) => {
  await app.open('/');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByRole('list', { name: 'Notifications' })).toBeVisible();
  await app.shot('notifications');
});

screen('command palette', {}, async ({ app, page }) => {
  await app.open('/');
  await expect(page.getByRole('heading', { name: 'Hello Ada' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search pages and entities').fill('pay');
  await expect(page.getByRole('option', { name: /Payments API/ }).first()).toBeVisible();
  await app.shot('command-palette');
});

screen('login', { who: 'anonymous' }, async ({ app, page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: /sign in/i }).first()).toBeVisible();
  await app.shot('login');
});

screen('not a member of the organization', { who: 'member' }, async ({ app, page }) => {
  await page.goto('/o/globex/');
  await expect(page.getByRole('heading', { name: 'You are not a member of globex' })).toBeVisible();
  await app.shot('not-a-member');
});
