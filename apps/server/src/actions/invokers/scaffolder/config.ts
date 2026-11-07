import { z } from 'zod';
import { checkEndpoint, checkNoSecretRefs, checkRefName, checkRepoName } from './security.js';

export const SCAFFOLD_PROVIDERS = ['github', 'gitlab', 'azure-devops'] as const;
export const SCAFFOLD_MODES = ['pull-request', 'new-repository'] as const;

const optionalString = z.string().optional();

/**
 * Configuration of the scaffolder invoker (before template rendering: values may still contain `{{ }}` / `${secret:}`).
 * Provider specific fields (e.g. `organization`, `project` for azure-devops) are listed here so every publisher reads
 * a typed config; unknown keys are kept.
 */
export const scaffoldConfigSchema = z
  .looseObject({
    type: z.literal('scaffolder').optional(),
    provider: z.enum(SCAFFOLD_PROVIDERS),
    /** pull-request: push a branch to an existing repository and open a PR/MR. new-repository: create `repo` first. */
    mode: z.enum(SCAFFOLD_MODES).default('pull-request'),
    templateRepo: z.string().min(1),
    templatePath: optionalString,
    templateRef: optionalString,
    repo: z.string().min(1),
    baseBranch: optionalString,
    targetPath: optionalString.refine((p) => !p?.includes('..') && !p?.includes('\\'), 'targetPath cannot contain .. or backslashes'),
    variables: z.unknown().optional(),
    title: optionalString,
    branch: optionalString,
    token: z.string().min(1),
    /** GitHub Enterprise API URL. */
    apiUrl: optionalString,
    /** GitLab base URL (also read as the GitHub API URL when `apiUrl` is not set). */
    baseUrl: optionalString,
    /** new-repository: description (Azure DevOps: commit message suffix / PR body), visibility (default private), topics (github). */
    description: optionalString,
    visibility: z.enum(['private', 'internal', 'public']).optional(),
    topics: z.union([z.array(z.string()), z.string()]).optional(),
    /** new-repository: branch that receives the initial commit (github: `baseBranch`; default main). */
    defaultBranch: optionalString,
    /** github new-repository: team slug (organisation repositories) granted `teamPermission` (default push) on the new repository. */
    team: optionalString,
    teamPermission: optionalString,
    /** github new-repository: `org` or `user`; detected from the token owner when not set. */
    ownerType: optionalString,
    /** new-repository: push into an existing non-empty repository instead of failing (empty ones are always filled). */
    reuseExisting: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional(),
    /** gitlab new-repository: group / sub-group path that owns the project (default: the part of `repo` before the last `/`). */
    namespace: optionalString,
    /** azure-devops: reviewer ids (array or comma separated). */
    reviewers: z.union([z.array(z.string()), z.string()]).optional(),
  })
  .superRefine((c, ctx) => {
    const check = (path: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        ctx.addIssue({ code: 'custom', path: [path], message: (e as Error).message });
      }
    };
    const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
    check('apiUrl', () => checkEndpoint('apiUrl', c.apiUrl));
    check('baseUrl', () => checkEndpoint('baseUrl', c.baseUrl));
    check('organization', () => checkEndpoint('organization', s(c.organization)));
    check('templateRepo', () => checkRepoName('templateRepo', c.templateRepo));
    check('repo', () => checkRepoName('repo', c.repo));
    for (const f of ['templateRef', 'baseBranch', 'defaultBranch', 'branch'] as const) check(f, () => checkRefName(f, c[f]));
    for (const f of ['variables', 'title', 'description', 'branch', 'targetPath', 'templatePath'] as const) check(f, () => checkNoSecretRefs(f, c[f]));
  });

export type ScaffoldConfig = z.infer<typeof scaffoldConfigSchema>;

/** Parse the configuration; throws an Error with a readable message. */
export function parseScaffoldConfig(config: Record<string, unknown>): ScaffoldConfig {
  const res = scaffoldConfigSchema.safeParse(config);
  if (res.success) return res.data;
  throw new Error(`scaffolder: ${res.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ')}`);
}
