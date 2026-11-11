import { expect, test as base, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test';
import { readSeed, type SeedState } from './seed';

/**
 * Visual regression harness: every screen is captured in light and dark (and with the sidebar folded where asked),
 * with everything that moves frozen so two runs — and two freshly seeded databases — give the same pixels:
 *
 *  - the browser clock is fixed (FIXED_NOW) and every timestamp of the API answers is rewritten relative to it, so
 *    "12 minutes ago", log clock times and durations never change;
 *  - the run event stream is cut (the page falls back to polling, whose answers are rewritten too);
 *  - writes are answered locally and never reach the server: the seed stays as it is for the next screenshot;
 *  - animations, transitions and the text caret are off; the fonts are loaded before a capture.
 */

export const FIXED_NOW = new Date('2026-03-12T14:30:00.000Z');
export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 390, height: 844 };

export type Theme = 'light' | 'dark';
export type Who = 'admin' | 'member' | 'anonymous';

// ---------------------------------------------------------------------------------------------------------------------
// Freezing API answers
// ---------------------------------------------------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Seconds after "the moment things happened" (FIXED_NOW − 12 min), by the field holding the timestamp. */
const KEY_OFFSET_S: Record<string, number> = { createdAt: 0, startedAt: 2, endedAt: 9, finishedAt: 9, updatedAt: 30, decidedAt: 6, at: 6 };

/**
 * Rewrites one JSON answer. Past timestamps become FIXED_NOW − 12 min (+ a few seconds by field, so runs last 7s),
 * the rows of a list each 23 min older than the previous one, log lines one second apart; future timestamps
 * (expiries) keep their distance to now, rounded to the day.
 */
export function freezeTimes(value: unknown, realNow = Date.now(), now = FIXED_NOW.getTime()): unknown {
  const walk = (v: unknown, key: string, shift: number, depth: number): unknown => {
    if (typeof v === 'string') {
      if (!ISO.test(v)) return v;
      const t = Date.parse(v);
      if (t > realNow + MINUTE) return new Date(now + Math.round((t - realNow) / DAY) * DAY).toISOString();
      return new Date(now - 12 * MINUTE + (KEY_OFFSET_S[key] ?? 0) * 1000 + shift).toISOString();
    }
    if (Array.isArray(v)) {
      const logs = v.length > 0 && v.every((x) => x && typeof x === 'object' && 'seq' in x && 'at' in x);
      // Rows of the answer itself (a list, or the `items` of a page) age by 23 minutes each.
      const rows = depth === 0 || (depth === 1 && key === 'items');
      return v.map((x, i) => walk(x, key, logs ? shift + (i - 6) * 1000 : rows ? shift - i * 23 * MINUTE : shift, depth + 1));
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k, shift, depth + 1)]));
    return v;
  };
  return walk(value, '', 0, 0);
}

/** POST requests that only read (searches, checks, previews): the others are answered locally. */
const READ_ONLY_POST = [/\/entities\/query$/, /\/expressions\/check$/, /\/dry-run$/, /\/impact$/, /\/auth\/login$/, /\/operations\/[^/]+\/render$/];

async function freezeApi(context: BrowserContext) {
  await context.route(/\/api\//, async (route: Route) => {
    const request = route.request();
    const url = request.url();
    // Server-sent events never end: cut them, the page polls instead (and says so nowhere).
    if (request.headers()['accept']?.includes('text/event-stream')) return route.abort();
    const method = request.method();
    if (method !== 'GET' && !READ_ONLY_POST.some((r) => r.test(new URL(url).pathname)))
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    try {
      const response = await route.fetch();
      const type = response.headers()['content-type'] ?? '';
      if (!type.includes('json')) return await route.fulfill({ response });
      const body = JSON.stringify(freezeTimes(JSON.parse(await response.text())));
      await route.fulfill({ response, body });
    } catch {
      // The page (or the test) went away while the request was in flight.
      await route.abort().catch(() => undefined);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------

const FREEZE_CSS = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }
`;

export interface Options {
  theme: Theme;
  /** Sidebar folded to icons. */
  folded: boolean;
  who: Who;
}

export const test = base.extend<Options & { seed: SeedState; app: App }>({
  theme: ['light', { option: true }],
  folded: [false, { option: true }],
  who: ['admin', { option: true }],
  // eslint-disable-next-line no-empty-pattern
  seed: async ({}, run) => run(readSeed()),
  colorScheme: async ({ theme }, run) => run(theme),
  context: async ({ context, theme, folded, who, seed }, run) => {
    await freezeApi(context);
    await context.addInitScript(
      ({ token, org, theme, folded, css }) => {
        if (token) localStorage.setItem('asterius.token', token);
        if (token) localStorage.setItem('asterius.org', org);
        localStorage.setItem('mantine-color-scheme-value', theme);
        localStorage.setItem('asterius.nav-collapsed', JSON.stringify(folded));
        const add = () => {
          const style = document.createElement('style');
          style.textContent = css;
          document.head.appendChild(style);
        };
        if (document.head) add();
        else document.addEventListener('DOMContentLoaded', add);
      },
      { token: who === 'anonymous' ? null : seed.tokens[who], org: seed.org, theme, folded, css: FREEZE_CSS },
    );
    await run(context);
  },
  page: async ({ page }, run) => {
    await page.clock.setFixedTime(FIXED_NOW);
    await run(page);
  },
  app: async ({ page, seed, theme, folded }, run) => run(new App(page, seed, theme, folded)),
});

export { expect };

/** The page under test, with the steps every screenshot shares. */
export class App {
  constructor(
    readonly page: Page,
    readonly seed: SeedState,
    readonly theme: Theme,
    readonly folded: boolean,
  ) {}

  /** Open a page of the seeded organization (`/runs` → `/o/acme/runs`). */
  async open(path: string) {
    await this.page.goto(`/o/${this.seed.org}${path}`);
  }

  /** Wait until nothing is loading any more: fonts, spinners, skeletons, lazy page chunks. */
  async settled() {
    const page = this.page;
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#root :is(main, form, h1, h2, h3)').first()).toBeVisible();
    await expect(page.locator('.mantine-Loader-root, .mantine-Skeleton-root, [aria-busy="true"]')).toHaveCount(0);
    await page.evaluate(async () => {
      // The bundled Inter Variable, in the weights the UI uses (a weight not yet painted is not loaded yet).
      await Promise.all(['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 14px "Inter Variable"`)));
      await document.fonts.ready;
    });
    // Away from anything with a hover style (the top edge of the header).
    await page.mouse.move(Math.round((page.viewportSize()?.width ?? 1440) / 2), 1);
  }

  /** `home` → `home-light.png` / `home-dark.png` / `home-folded-light.png`. */
  name(screen: string) {
    return `${screen}${this.folded ? '-folded' : ''}-${this.theme}.png`;
  }

  /** Capture the viewport once the page is settled. */
  async shot(screen: string, options: { mask?: Locator[]; fullPage?: boolean } = {}) {
    await this.settled();
    await expect(this.page).toHaveScreenshot(this.name(screen), options);
  }
}

/**
 * Declare one screen: a test per theme, plus the folded sidebar when asked.
 * `screen('runs', { folded: true }, async ({ app }) => { … await app.shot('runs') })`.
 */
type Body = Parameters<typeof test>[2];
export function screen(title: string, options: { folded?: boolean; who?: Who; viewport?: { width: number; height: number } }, body: Body) {
  const variants: { theme: Theme; folded: boolean }[] = [
    { theme: 'light', folded: false },
    { theme: 'dark', folded: false },
    ...(options.folded
      ? ([
          { theme: 'light', folded: true },
          { theme: 'dark', folded: true },
        ] as const)
      : []),
  ];
  for (const v of variants) {
    test.describe(`${v.theme}${v.folded ? ', sidebar folded' : ''}`, () => {
      test.use({ ...v, ...(options.who ? { who: options.who } : {}), ...(options.viewport ? { viewport: options.viewport } : {}) });
      test(title, body);
    });
  }
}
