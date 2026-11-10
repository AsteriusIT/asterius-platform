/**
 * The organization lives in the URL: every organization-scoped page is under `/o/<slug>/…`, through the router
 * `basename`, so app links (`<Link to="/catalog">`, `navigate('/runs/x')`) stay relative to the tab's organization.
 * localStorage (orgStore) only remembers the default organization for new visits and unprefixed URLs.
 */

const PREFIX = /^\/o\/([^/?#]+)(\/.*)?$/;

/** Pages that are not organization-scoped: they live outside the `/o/<slug>` prefix. */
const OUTSIDE = [/^\/login\/?$/, /^\/auth(\/|$)/, /^\/welcome\/?$/, /^\/platform(\/|$)/, /^\/orgs\/new\/?$/];

export const isOrgScoped = (path: string) => !OUTSIDE.some((r) => r.test(path));

/** `/o/<slug>/rest` → { slug, rest: '/rest' }; null for an unprefixed path. */
export function splitOrgPath(pathname: string): { slug: string; rest: string } | null {
  const m = PREFIX.exec(pathname);
  if (!m) return null;
  try {
    return { slug: decodeURIComponent(m[1]), rest: m[2] || '/' };
  } catch {
    return null;
  }
}

/** Path of a page inside an organization. */
export const orgPath = (slug: string, path = '/') => `/o/${encodeURIComponent(slug)}${path.startsWith('/') ? path : `/${path}`}`;

/** Router basename of an organization. */
export const orgBase = (slug: string) => `/o/${encodeURIComponent(slug)}`;

/** The organization of this tab, from its URL (null outside the prefix). */
export function urlOrg(): string | null {
  if (typeof window === 'undefined') return null;
  return splitOrgPath(window.location.pathname)?.slug ?? null;
}

export interface BootRoute {
  /** Router basename (`/o/<slug>`), undefined for the pages outside organizations. */
  basename?: string;
  /** Rewrite the address bar to this URL first (legacy unprefixed URL, default organization known). */
  replace?: string;
}

/**
 * How the app starts for a URL: inside the organization of a `/o/<slug>` URL; an unprefixed organization page (old
 * bookmark, link in an email) moves under the remembered default organization when there is one; else the page is
 * served outside organizations (login, platform pages…, or a redirect once the server tells the default).
 */
export function bootRoute(loc: { pathname: string; search: string; hash: string }, stored: string | null): BootRoute {
  const inOrg = splitOrgPath(loc.pathname);
  if (inOrg) return { basename: orgBase(inOrg.slug) };
  if (stored && isOrgScoped(loc.pathname)) return { basename: orgBase(stored), replace: orgPath(stored, loc.pathname) + loc.search + loc.hash };
  return {};
}

/** Set at boot when an unprefixed URL was moved under the remembered organization (see `bootRoute`). */
export const legacyRedirect = { from: null as string | null };

/** A link to an app page stored as a path (`/runs/x`), made absolute for an `href` in the tab's organization. */
export function appHref(link: string): string {
  if (!link.startsWith('/') || link.startsWith('//') || link.startsWith('/api/') || splitOrgPath(link)) return link;
  const slug = urlOrg();
  return slug ? orgPath(slug, link) : link;
}

/** The sign-in page, back to `returnTo` (a full path, `/o/<slug>/…` included) afterwards. */
export const loginPath = (returnTo: string) => (returnTo === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(returnTo)}`);

/** A `returnTo` given in a URL, when it is a path of this site. */
export const safeReturnTo = (v: string | null | undefined) => (v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : null);

/** Leave the router (another organization, or a page outside organizations): a full page load. */
export const hardNavigate = (url: string, replace = true) => (replace ? window.location.replace(url) : window.location.assign(url));
