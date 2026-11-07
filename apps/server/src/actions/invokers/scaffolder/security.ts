import { assertUrlAllowed, isExplicitlyAllowed } from '../../../lib/netguard.js';

/** Static security checks of the scaffolder configuration and its output (see docs/EXTENDING.md, "Scaffolder security"). */

/** A value that still holds a `{{ }}` / `${...}` reference is validated again once rendered. */
export const isTemplated = (v: string) => v.includes('{{') || v.includes('${');

/**
 * Provider endpoints (`apiUrl`, `baseUrl`, `organization`) receive the token, so they are checked before any call:
 * http(s) only, no credentials in the URL, https unless the admin allow-listed the host (OUTBOUND_ALLOW), and no
 * private / loopback / link-local address literal (hostnames are checked again at connect time by the SSRF guard).
 */
export function checkEndpoint(field: string, value: string | undefined) {
  if (!value || isTemplated(value)) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is not a valid URL`);
  }
  if (url.username || url.password) throw new Error(`${field} must not contain credentials`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${field} must be an https URL`);
  if (url.protocol === 'http:' && !isExplicitlyAllowed(url.hostname))
    throw new Error(`${field} must use https (plain http is only accepted for hosts in OUTBOUND_ALLOW)`);
  try {
    assertUrlAllowed(url);
  } catch (e) {
    throw new Error(`${field}: ${(e as Error).message}`, { cause: e });
  }
}

/** Repository identifiers end up in API paths: only plain name segments (no `.`, `..`, query or fragment characters). */
export function checkRepoName(field: string, value: string | undefined) {
  if (!value || isTemplated(value)) return;
  const segments = value.split('/');
  if (segments.some((s) => !/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(s) || s === '.' || s === '..' || s.endsWith('.')))
    throw new Error(`${field} contains characters that are not allowed in a repository name`);
}

/** Branch / tag / sha names are placed in API paths and queries: refuse traversal and git-invalid characters. */
export function checkRefName(field: string, value: string | undefined) {
  if (!value || isTemplated(value)) return;
  /* eslint-disable no-control-regex */
  if (
    /[\u0000-\u0020\u007f~^:?*[#%&\\]/.test(value) ||
    value.split('/').some((s) => s === '' || s === '.' || s === '..') ||
    value.startsWith('-') ||
    value.includes('@{')
  )
    throw new Error(`${field} is not a valid git ref name`);
  /* eslint-enable no-control-regex */
}

/** Secrets and run credentials must never travel through variables, titles, descriptions or branch names. */
export function checkNoSecretRefs(field: string, value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (/\$\{\s*(secret|env):/i.test(text))
    throw new Error(
      `${field} cannot reference secrets (\${secret:…} / \${env:…}): the value would be written into the repository. Only "token" may be a secret`,
    );
}

/** Last line of defence: fail when a credential value appears in a file about to be committed. */
export function assertNoSecretsIn(files: Array<{ path: string; content: string }>, secrets: Array<string | undefined>) {
  const needles = secrets.filter((s): s is string => !!s && s.length >= 8);
  if (!needles.length) return;
  for (const f of files) {
    const text = Buffer.from(f.content, 'base64').toString('latin1');
    const hay = `${f.path}\n${text}`;
    if (needles.some((n) => hay.includes(n))) throw new Error(`scaffolder: a credential would be written into "${f.path}"; refusing to publish`);
  }
}

/** True for `.git` (any case) used as a path segment: git metadata must never be written by a scaffold. */
export const isGitMetadata = (segment: string) => segment.toLowerCase() === '.git';
