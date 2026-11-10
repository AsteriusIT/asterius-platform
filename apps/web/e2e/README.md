# End-to-end tests

Playwright, against a real API server (fresh SQLite database) and a production build of the web app.

```bash
npx playwright install chromium     # once
npm run e2e -w apps/web             # functional tests (portal.spec.ts)
npm run e2e:visual -w apps/web      # screenshots of the main screens, compared with the baselines
npm run e2e:update -w apps/web      # regenerate the baselines after an intended visual change
```

`e2e:update` takes Playwright arguments, e.g. `npm run e2e:update -w apps/web -- -g "run, graph"` for one screen.

## How it runs

- Playwright starts its own stack on ports **18080** (API) and **15173** (web), next to a running `npm run dev`
  (`E2E_API_PORT` / `E2E_WEB_PORT` to change them). Data lives in `$TMPDIR/asterius-e2e` (`E2E_DIR`), wiped each time
  the API server starts. The web app is built (`vite build`) and served by `vite preview` (`e2e/vite.config.ts`).
- Outside CI a stack that is already running is reused (and its data kept). After changing `apps/web/src` or the seed,
  stop it so the next run rebuilds and reseeds: `lsof -ti tcp:18080 -ti tcp:15173 | xargs kill`.
- `support/seed.ts` (global setup) fills the organization `acme` through the public API: an admin (Ada), two members,
  three teams, three blueprints and their entities (the `docs` property is left empty: no network), six workflows (one
  uses the fragment `platform-approval`, one always fails on an invoke step) and seven runs: succeeded, approved,
  rejected, failed, cancelled, one request pending approval and one waiting on an approval step.
- The functional tests work in their own organization (`e2e`), so they never change a screenshot.

## Visual tests

`visual/*.spec.ts` declare screens with `screen(title, options, body)` (`support/visual.ts`): one test in light and one
in dark, plus the sidebar folded with `{ folded: true }`. Baselines are in `visual/screenshots/<platform>/<name>.png`.

| File              | Screens                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `shell.spec.ts`   | home (+ folded), home on a phone with the navigation open (390×844), notifications panel, command palette, login, not-a-member |
| `work.spec.ts`    | to do (+ folded), self-service, run dialog, runs (+ folded), run graph, run "All logs" panel, step waiting for an approval    |
| `catalog.spec.ts` | catalog list (+ folded), filtered list with the views menu, entity overview, entity history                          |
| `admin.spec.ts`   | workflow editor, step dialog, blueprints (+ folded), blueprint editor, users, teams                                  |

What keeps the pixels stable (all in `support/visual.ts`):

- 1440×900 viewport, device scale factor 1, `en-US`, UTC, reduced motion; CSS turns transitions, animations and the
  caret off; captures wait for Inter Variable (`document.fonts`), and for spinners and skeletons to go.
- The browser clock is fixed (`FIXED_NOW`) and every timestamp in the API answers is rewritten relative to it, so
  relative times, log clock times and durations are the same on every run and on every freshly seeded database.
- The run event stream (SSE) is cut: the run page polls instead, and those answers are frozen too. The `live` badge
  depends on the run status, not on the stream, so it is still shown.
- Writes from the page are answered by the harness and never reach the server (opening a notification would mark it
  read and change the next screenshot). Visual tests are read-only, which is why they run in parallel.
- The API allows 600 requests a minute per client address; the test proxy spreads the suite over many addresses
  (`X-Forwarded-For`, trusted from loopback).

Tolerance (`playwright.config.ts`): `maxDiffPixelRatio: 0.001` and `threshold: 0.1`. On one machine the captures are
pixel-identical run after run; the budget (0.1 % of 1440×900 ≈ 1300 pixels, less than a 40×40 icon) only absorbs
anti-aliasing noise, so a moved, missing or recoloured element fails. Do not raise it to make a test pass: fix the
source of the movement, or `mask` the region (`app.shot(name, { mask: [locator] })`).

After a failure, `test-results/<test>/` holds `*-actual.png`, `*-expected.png` and `*-diff.png`.

## Baselines per platform

Text is rasterised differently on macOS and Linux, so each platform has its own folder. The committed baselines are
`visual/screenshots/darwin` (macOS, Chromium of Playwright 1.65). **CI on Linux needs `visual/screenshots/linux`**:
generate them in the Playwright image of the same version, from the repository root, and commit them:

```bash
docker run --rm --ipc=host -v "$PWD":/work -v /work/node_modules -w /work mcr.microsoft.com/playwright:v1.65.0-noble \
  sh -c 'npm ci && CI=1 npm run e2e:update -w apps/web'
```

(`-v /work/node_modules` keeps the container's Linux binaries out of the host's `node_modules`.) Run the visual
tests in CI in that same image; without Linux baselines the first run writes them and fails. Regenerate both folders
when Playwright is upgraded (new Chromium build).
