import { z } from 'zod';

export const SCAFFOLD_PROVIDERS = ['github', 'gitlab', 'azure-devops'] as const;
export const SCAFFOLD_MODES = ['pull-request', 'new-repository'] as const;

const optionalString = z.string().optional();

/**
 * Configuration of the scaffolder invoker (before template rendering: values may still contain `{{ }}` / `${secret:}`).
 * Provider specific fields (e.g. `organization`, `project` for azure-devops) are listed here so every publisher reads
 * a typed config; unknown keys are kept.
 */
export const scaffoldConfigSchema = z.looseObject({
  type: z.literal('scaffolder').optional(),
  provider: z.enum(SCAFFOLD_PROVIDERS),
  /** pull-request: push a branch to an existing repository and open a PR/MR. new-repository: create `repo` first. */
  mode: z.enum(SCAFFOLD_MODES).default('pull-request'),
  templateRepo: z.string().min(1),
  templatePath: optionalString,
  templateRef: optionalString,
  repo: z.string().min(1),
  baseBranch: optionalString,
  targetPath: optionalString.refine((p) => !p?.includes('..'), 'targetPath cannot contain ..'),
  variables: z.unknown().optional(),
  title: optionalString,
  branch: optionalString,
  token: z.string().min(1),
  /** GitHub Enterprise API URL. */
  apiUrl: optionalString,
  /** GitLab base URL (also read as the GitHub API URL when `apiUrl` is not set). */
  baseUrl: optionalString,
  /** azure-devops */
  organization: optionalString,
  project: optionalString,
  /** new-repository: branch that receives the initial commit (default main). */
  defaultBranch: optionalString,
  /** Repository / pull request description. */
  description: optionalString,
  /** new-repository: push into an existing non-empty repository instead of failing. */
  reuseExisting: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional(),
  /** azure-devops: reviewer ids (array or comma separated). */
  reviewers: z.union([z.array(z.string()), z.string()]).optional(),
});

export type ScaffoldConfig = z.infer<typeof scaffoldConfigSchema>;

/** Parse the configuration; throws an Error with a readable message. */
export function parseScaffoldConfig(config: Record<string, unknown>): ScaffoldConfig {
  const res = scaffoldConfigSchema.safeParse(config);
  if (res.success) return res.data;
  throw new Error(`scaffolder: ${res.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ')}`);
}
