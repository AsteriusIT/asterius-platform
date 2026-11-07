import { str } from '../types.js';

/** Azure DevOps helpers shared by the pipeline invoker and the scaffolder publisher. */

/** `{organization URL}/{project}`: `organization` is the full URL, e.g. https://dev.azure.com/my-org. */
export const adoBase = (c: Record<string, unknown>) => `${adoOrg(c)}/${encodeURIComponent(str(c.project))}`;
export const adoOrg = (c: Record<string, unknown>) => str(c.organization).replace(/\/$/, '');

/** A PAT (Basic) or an Entra access token for a service principal / managed identity (`Bearer <token>`). */
export const adoAuth = (c: Record<string, unknown>) => {
  const t = str(c.token);
  return { authorization: t.startsWith('Bearer ') ? t : `Basic ${Buffer.from(`:${t}`).toString('base64')}` };
};
