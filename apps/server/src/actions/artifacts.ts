import { createHash } from 'node:crypto';
import type { RunArtifact } from '@asterius/shared';
import { config } from '../config.js';
import { all, forUpdate, newId, now, one, tx, type SqlValue } from '../db.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { addLog } from './runs.js';

/**
 * Run artifacts: files attached to a run step (a Terraform plan, a test report, a generated config…). The metadata and
 * the content live in `run_artifacts` (BLOB / BYTEA), capped by ARTIFACT_MAX_BYTES per file and RUN_ARTIFACTS_MAX per
 * run, restricted to ARTIFACT_CONTENT_TYPES, and deleted with the run (foreign key cascade: retention). Uploaded by the
 * step's callback (`POST /runs/:id/steps/:step/artifacts`, step token), by the webhook invoker's sync answer
 * (`artifacts: [...]`) or by the requester / an admin. Later steps read `steps.<id>.artifacts` (metadata and URL).
 */

export interface ArtifactInput {
  name: string;
  contentType: string;
  /** Base64 (JSON uploads and invoker answers). */
  content: string;
}

interface Row {
  id: string;
  run_id: string;
  step_id: string | null;
  name: string;
  content_type: string;
  size: number;
  sha256: string;
  created_at: string;
  created_by: string | null;
}

const COLUMNS = 'id, run_id, step_id, name, content_type, size, sha256, created_at, created_by';

const toArtifact = (r: Row): RunArtifact => ({
  id: r.id,
  stepId: r.step_id,
  name: r.name,
  contentType: r.content_type,
  size: Number(r.size),
  sha256: r.sha256,
  createdAt: r.created_at,
  createdBy: r.created_by,
});

export const artifactUrl = (runId: string, id: string) => `${config.PUBLIC_URL}/api/v1/runs/${runId}/artifacts/${id}`;

/** Body limit of an upload route: the base64 form of the largest artifact plus the JSON envelope. */
export const artifactBodyLimit = () => Math.ceil((config.ARTIFACT_MAX_BYTES * 4) / 3) + 64 * 1024;

/** `text/plain; charset=utf-8` → `text/plain`, checked against ARTIFACT_CONTENT_TYPES (`type/*` wildcards). */
export function allowedContentType(raw: string): string {
  const type = raw.split(';')[0]!.trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) throw badRequest(`Invalid content type "${raw}"`);
  const allowed = config.ARTIFACT_CONTENT_TYPES.split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.some((a) => a === type || (a.endsWith('/*') && type.startsWith(a.slice(0, -1)))))
    throw badRequest(`Content type "${type}" is not accepted for artifacts (ARTIFACT_CONTENT_TYPES)`);
  return type;
}

/** A file name safe for storage and the download header: no path, no control characters, at most 200 characters. */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  if (!name || name === '.' || name === '..') throw badRequest('Artifact name is required');
  return name.slice(0, 200);
}

function decode(content: string): Buffer {
  if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(content)) throw badRequest('Artifact content must be base64');
  return Buffer.from(content, 'base64');
}

/**
 * Store one artifact. The count cap is checked under a row lock on the run, so concurrent uploads cannot exceed it.
 * `createdBy`: the uploader's email, or `step:<id>` for callbacks and invokers.
 */
export async function addArtifact(runId: string, stepId: string | null, input: ArtifactInput, createdBy: string | null): Promise<RunArtifact> {
  const name = safeName(input.name);
  const contentType = allowedContentType(input.contentType);
  const data = decode(input.content);
  if (data.length > config.ARTIFACT_MAX_BYTES)
    throw new HttpError(413, `Artifact too large: ${data.length} bytes (limit ARTIFACT_MAX_BYTES=${config.ARTIFACT_MAX_BYTES})`);
  if (stepId && !(await one('SELECT step_id FROM run_steps WHERE run_id = ? AND step_id = ?', runId, stepId))) throw notFound(`Step "${stepId}"`);
  const row: Row = {
    id: newId(),
    run_id: runId,
    step_id: stepId,
    name,
    content_type: contentType,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    created_at: now(),
    created_by: createdBy,
  };
  await tx(async (d) => {
    const run = (await d.query<{ org_id: string | null }>(`SELECT org_id FROM runs WHERE id = ?${forUpdate}`, [runId])).rows[0];
    if (!run) throw notFound('Run');
    const [{ n }] = (await d.query<{ n: number }>('SELECT count(*) AS n FROM run_artifacts WHERE run_id = ?', [runId])).rows as [{ n: number }];
    if (Number(n) >= config.RUN_ARTIFACTS_MAX) throw conflict(`This run already has ${n} artifacts (limit RUN_ARTIFACTS_MAX=${config.RUN_ARTIFACTS_MAX})`);
    await d.query(
      `INSERT INTO run_artifacts (${COLUMNS}, org_id, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // node:sqlite binds Uint8Array as a BLOB, pg binds a Buffer as BYTEA.
      [row.id, runId, stepId, name, contentType, row.size, row.sha256, row.created_at, createdBy, run.org_id, data as unknown as SqlValue],
    );
  });
  await addLog(runId, `Artifact attached: ${name} (${contentType}, ${row.size} bytes)`, 'info', stepId);
  return toArtifact(row);
}

export async function listArtifacts(runId: string): Promise<RunArtifact[]> {
  return (await all<Row>(`SELECT ${COLUMNS} FROM run_artifacts WHERE run_id = ? ORDER BY created_at, id`, runId)).map(toArtifact);
}

export async function getArtifact(runId: string, id: string): Promise<{ artifact: RunArtifact; content: Buffer }> {
  const r = await one<Row & { content: Uint8Array }>(`SELECT ${COLUMNS}, content FROM run_artifacts WHERE run_id = ? AND id = ?`, runId, id);
  if (!r) throw notFound('Artifact');
  return { artifact: toArtifact(r), content: Buffer.from(r.content) };
}

/** Template data: `steps.<id>.artifacts` = [{ id, name, contentType, size, sha256, url }]. */
export async function artifactsByStep(runId: string): Promise<Map<string, (Omit<RunArtifact, 'stepId' | 'createdBy' | 'createdAt'> & { url: string })[]>> {
  const out = new Map<string, (Omit<RunArtifact, 'stepId' | 'createdBy' | 'createdAt'> & { url: string })[]>();
  for (const a of await listArtifacts(runId)) {
    if (!a.stepId) continue;
    out.set(a.stepId, [
      ...(out.get(a.stepId) ?? []),
      { id: a.id, name: a.name, contentType: a.contentType, size: a.size, sha256: a.sha256, url: artifactUrl(runId, a.id) },
    ]);
  }
  return out;
}

/**
 * Artifacts returned by an invoker (the webhook invoker's sync answer): stored one by one; a rejected file is logged
 * and does not fail the step.
 */
export async function storeInvokerArtifacts(runId: string, stepId: string, items: unknown) {
  if (!Array.isArray(items)) return;
  for (const raw of items.slice(0, config.RUN_ARTIFACTS_MAX)) {
    const a = raw as Partial<ArtifactInput> | null;
    try {
      if (!a || typeof a.name !== 'string' || typeof a.content !== 'string')
        throw badRequest('each artifact needs a name and a base64 content (and a contentType)');
      await addArtifact(
        runId,
        stepId,
        { name: a.name, contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream', content: a.content },
        `step:${stepId}`,
      );
    } catch (err) {
      await addLog(runId, `Artifact rejected: ${(err as Error).message}`, 'warn', stepId);
    }
  }
}

/** RFC 6266 attachment header: an ASCII fallback plus the UTF-8 name. */
export function contentDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
