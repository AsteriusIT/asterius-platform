import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { actorOf, requireAdmin } from '../auth/users.js';
import { checkFragmentChange } from '../actions/actions.js';
import { deleteFragment, fragmentUsers, getFragment, listFragments, listFragmentVersions, upsertFragment } from '../actions/fragments.js';
import { fragmentDef } from '../schemas.js';
import { idParam } from './util.js';

/** Step fragments (admins only: they hold workflow configuration). */
export async function fragmentRoutes(app: FastifyInstance) {
  app.get('/fragments', { preHandler: requireAdmin }, async () => listFragments());
  app.get('/fragments/:id', { preHandler: requireAdmin }, async (req) => getFragment(idParam.parse(req.params).id));
  app.get('/fragments/:id/usage', { preHandler: requireAdmin }, async (req) => fragmentUsers(idParam.parse(req.params).id));
  app.get('/fragments/:id/versions', { preHandler: requireAdmin }, async (req) => listFragmentVersions(idParam.parse(req.params).id));
  app.put('/fragments/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const def = fragmentDef.parse({ ...(req.body as object), identifier: id });
    // Workflows using it must still be valid with the new definition (new runs only: runs keep their inlined copy).
    await checkFragmentChange(def);
    const { fragment, created, changed } = await upsertFragment(def, { actor: actorOf(req.principal) });
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
