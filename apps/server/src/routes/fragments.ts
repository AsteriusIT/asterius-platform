import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf, requireAdmin } from '../auth/users.js';
import { checkFragmentChange } from '../actions/actions.js';
import { deleteFragment, fragmentUsers, getFragment, getFragmentVersion, listFragments, listFragmentVersions, upsertFragment } from '../actions/fragments.js';
import { diffDefinitions } from '../actions/versions.js';
import { fragmentDef, type FragmentDef } from '../schemas.js';
import { ifMatchOf } from '../lib/conflict.js';
import { idParam } from './util.js';

const versionNumber = z.coerce.number().int().min(1);

/** Step fragments (admins only: they hold workflow configuration). */
export async function fragmentRoutes(app: FastifyInstance) {
  /** Save a definition: workflows using it must still be valid with it (new runs only: runs keep their inlined copy). */
  const save = async (def: FragmentDef, req: { principal: Parameters<typeof actorOf>[0] }, ifMatch?: number) => {
    await checkFragmentChange(def);
    return upsertFragment(def, { actor: actorOf(req.principal), ifMatch });
  };

  app.get('/fragments', { preHandler: requireAdmin }, async () => listFragments());
  app.get('/fragments/:id', { preHandler: requireAdmin }, async (req) => getFragment(idParam.parse(req.params).id));
  app.get('/fragments/:id/usage', { preHandler: requireAdmin }, async (req) => fragmentUsers(idParam.parse(req.params).id));
  app.get('/fragments/:id/versions', { preHandler: requireAdmin }, async (req) => listFragmentVersions(idParam.parse(req.params).id));
  app.get('/fragments/:id/versions/:version', { preHandler: requireAdmin }, async (req) => {
    const { id, version } = z.object({ id: z.string().min(1).max(200), version: versionNumber }).parse(req.params);
    return getFragmentVersion(id, version);
  });
  /** What changed between two versions (same shape as the action diff). */
  app.get('/fragments/:id/diff', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ from: versionNumber, to: versionNumber }).parse(req.query);
    const [from, to] = await Promise.all([getFragmentVersion(id, q.from), getFragmentVersion(id, q.to)]);
    return diffDefinitions(from.definition, to.definition);
  });
  /** Restore an old definition as a new version (checked against the workflows using it, like a save). */
  app.post('/fragments/:id/rollback', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { version } = z.object({ version: versionNumber }).parse(req.body ?? {});
    const target = await getFragmentVersion(id, version);
    const { fragment, changed } = await save(fragmentDef.parse({ ...target.definition, identifier: id }), req);
    if (changed) await audit(actorOf(req.principal), 'fragment.rolled_back', id, { to: version, version: fragment.version });
    return fragment;
  });
  app.put('/fragments/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const def = fragmentDef.parse({ ...(req.body as object), identifier: id });
    const { fragment, created, changed } = await save(def, req, ifMatchOf(req.headers['if-match']));
    if (created || changed) await audit(actorOf(req.principal), created ? 'fragment.created' : 'fragment.updated', id, { version: fragment.version });
    return fragment;
  });
  app.delete('/fragments/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await deleteFragment(id);
    await audit(actorOf(req.principal), 'fragment.deleted', id);
    return { ok: true };
  });
}
