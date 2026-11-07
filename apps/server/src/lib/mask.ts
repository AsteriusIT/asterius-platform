import { redact } from './expr.js';

/** Shapes of credentials that may show up in upstream error bodies and log lines. */
const PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ****'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|astrun_[A-Za-z0-9_-]{16,})\b/g, '****'],
  [
    /(["']?(?:access_?token|refresh_?token|token|password|passwd|secret|client_?secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&}]{4,}/gi,
    '$1****',
  ],
  [/(\/\/[^/\s:@]+:)[^/\s@]+(@)/g, '$1****$2'], // user:password@host in URLs
];

/** Mask known secret values and common credential shapes before text is persisted or logged. */
export function maskText(text: string, secrets: string[] = []): string {
  let out = redact(text, secrets);
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}
