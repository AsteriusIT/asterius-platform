/** Helpers to copy the logs of external CI jobs into run logs: size caps, ANSI/timestamp cleanup, per-job prefix. */

export const MAX_LOG_LINES_PER_JOB = 300;
export const MAX_LOG_LINE_LENGTH = 1000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const LEADING_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;

/** Lines worth showing: the tail of the log (where failures are), cleaned and truncated. */
export function tailLines(text: string, max = MAX_LOG_LINES_PER_JOB): { lines: string[]; skipped: number } {
  const all = text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.replace(LEADING_TS, '').trimEnd())
    .filter((l) => l.length > 0);
  const skipped = Math.max(0, all.length - max);
  return { lines: all.slice(-max).map((l) => (l.length > MAX_LOG_LINE_LENGTH ? `${l.slice(0, MAX_LOG_LINE_LENGTH)}…` : l)), skipped };
}

export type LogFn = (message: string, level?: 'info' | 'warn' | 'error') => Promise<void>;

/** Write a job's log to the run log, each line prefixed with `[job]` so the run page can group them. */
export async function emitJobLog(log: LogFn, job: string, text: string, failed: boolean, max = MAX_LOG_LINES_PER_JOB) {
  const { lines, skipped } = tailLines(text, max);
  if (skipped) await log(`[${job}] … ${skipped} earlier line(s) omitted`, 'warn');
  for (const l of lines) await log(`[${job}] ${l}`, failed && /\b(error|fail(ed|ure)?|fatal|exception)\b/i.test(l) ? 'error' : 'info');
}
