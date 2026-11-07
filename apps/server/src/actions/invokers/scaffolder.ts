import { audit } from '../../audit.js';
import { stringValues, type InvokeEnv, type InvokeResult, type Invoker } from '../types.js';
import {
  getPublisher,
  parseScaffoldConfig,
  renderFiles,
  renderText,
  SCAFFOLD_MODES,
  SCAFFOLD_PROVIDERS,
  unsupportedMode,
  type ScaffoldOutput,
} from './scaffolder/index.js';
import { assertNoSecretsIn } from './scaffolder/security.js';

/**
 * Repository scaffolder: renders a template repository (cookiecutter style `{{ variable }}` placeholders in file
 * paths and text files) and publishes the result. Placeholders are plain substitutions: no code runs from templates.
 *
 * Providers live in `scaffolder/<provider>.ts` behind the `ScaffoldPublisher` interface. Modes: `pull-request`
 * (existing repository, opens a PR/MR) and `new-repository` (github: creates the repository).
 *
 * Result (stable contract): `{ repoUrl, prUrl, branch, commit, provider, files }`, plus the legacy
 * `pullRequest` (= prUrl) and `number` (PR/MR number).
 */

export { renderFiles, renderText };

export const scaffolderInvoker: Invoker = {
  info: {
    type: 'scaffolder',
    title: 'Repository scaffolder',
    description: 'Render a template repository with variables and open a pull request in the target repository.',
    fields: [
      { key: 'provider', label: 'Provider', kind: 'select', options: [...SCAFFOLD_PROVIDERS], required: true },
      {
        key: 'mode',
        label: 'Publish mode',
        kind: 'select',
        options: [...SCAFFOLD_MODES],
        help: 'pull-request: PR/MR on an existing repository. new-repository: create the repository (GitHub, GitLab, Azure DevOps)',
      },
      { key: 'templateRepo', label: 'Template repository', kind: 'text', required: true, placeholder: 'org/template-service' },
      { key: 'templatePath', label: 'Template sub-directory', kind: 'text' },
      { key: 'templateRef', label: 'Template ref', kind: 'text', placeholder: 'main' },
      { key: 'repo', label: 'Target repository', kind: 'text', required: true, placeholder: 'org/new-service' },
      { key: 'baseBranch', label: 'Base branch', kind: 'text', placeholder: 'main' },
      { key: 'targetPath', label: 'Directory in the target', kind: 'text', placeholder: '.' },
      { key: 'variables', label: 'Template variables', kind: 'keyvalue' },
      { key: 'title', label: 'Pull request title', kind: 'text' },
      { key: 'description', label: 'Description (new-repository; PR body on Azure DevOps)', kind: 'text', advanced: true },
      { key: 'visibility', label: 'Visibility (new-repository)', kind: 'select', options: ['private', 'internal', 'public'], advanced: true },
      { key: 'team', label: 'Team slug granted access (GitHub new-repository)', kind: 'text', advanced: true },
      { key: 'teamPermission', label: 'Team permission', kind: 'select', options: ['pull', 'triage', 'push', 'maintain', 'admin'], advanced: true },
      { key: 'reuseExisting', label: 'Reuse a non-empty existing repository (new-repository)', kind: 'boolean', advanced: true },
      { key: 'token', label: 'Token', kind: 'secret', required: true },
      { key: 'namespace', label: 'GitLab group / namespace (new-repository)', kind: 'text', advanced: true, placeholder: 'my-group/sub' },
      { key: 'defaultBranch', label: 'Default branch (new-repository)', kind: 'text', advanced: true, placeholder: 'main' },
      { key: 'baseUrl', label: 'API URL (GitHub Enterprise / GitLab)', kind: 'text', advanced: true },
      { key: 'organization', label: 'Organization URL (Azure DevOps)', kind: 'text', placeholder: 'https://dev.azure.com/my-org' },
      { key: 'project', label: 'Project (Azure DevOps)', kind: 'text' },
      { key: 'reviewers', label: 'Reviewer ids (Azure DevOps, comma separated)', kind: 'text', advanced: true },
    ],
    example: {
      type: 'scaffolder',
      provider: 'github',
      mode: 'pull-request',
      templateRepo: 'my-org/template-service',
      templateRef: 'main',
      repo: 'my-org/{{ inputs.name }}',
      variables: { name: '{{ inputs.name }}', owner: '{{ trigger.user.email }}' },
      title: 'Scaffold {{ inputs.name }}',
      token: '${secret:GITHUB_TOKEN}',
    },
  },
  validate(c) {
    parseScaffoldConfig(c);
  },
  async start(env) {
    const token = typeof env.config.token === 'string' ? env.config.token : '';
    try {
      return await publishScaffold(env);
    } catch (e) {
      // Defence in depth (the engine masks run secrets too): a provider error can echo the credential it rejected.
      // eslint-disable-next-line preserve-caught-error -- the cause could carry the token
      throw new Error(redactToken((e as Error).message, token).slice(0, 1000));
    }
  },
};

/** Remove the token (raw and as the Basic header value) from a message. */
export function redactToken(message: string, token: string): string {
  if (token.length < 4) return message;
  const forms = [token, Buffer.from(`:${token}`).toString('base64'), token.replace(/^Bearer /, '')];
  return forms.filter((f) => f.length >= 4).reduce((m, f) => m.split(f).join('***'), message);
}

async function publishScaffold({ config, ctx, log }: InvokeEnv): Promise<InvokeResult> {
  {
    const c = parseScaffoldConfig(config);
    const publisher = getPublisher(c);
    if (!publisher.modes.includes(c.mode)) throw unsupportedMode(c.provider, c.mode); // before any network call
    const vars = stringValues(c.variables);
    await log(`Reading template ${c.templateRepo}`);
    const template = await publisher.readTemplate(c);
    const files = renderFiles(template, vars, c.targetPath || '.');
    if (!files.length) throw new Error('the template produced no files');
    assertNoSecretsIn(files, [c.token, ctx.run.callback.token]);
    if (files.some((f) => f.path.toLowerCase().startsWith('.github/workflows/')))
      await log('Template contains .github/workflows: the GitHub token needs the "workflow" scope (classic) or Workflows: write (fine-grained)', 'warn');
    await log(`Rendered ${files.length} file(s)`);
    const branch = c.branch || `scaffold/${ctx.run.id.slice(0, 8)}`;
    const title = c.title || `Scaffold from ${c.templateRepo}`;
    const { number, ...output }: ScaffoldOutput & { number?: number | null } = await publisher.publish({
      config: c,
      files,
      branch,
      title,
      body: `Generated by Asterius run ${ctx.run.url}`,
    });
    const user = ctx.trigger?.user;
    await audit({ id: user?.id || null, email: user?.email || null }, 'scaffold.published', output.prUrl ?? output.repoUrl, {
      runId: ctx.run.id,
      provider: output.provider,
      mode: c.mode,
      repoUrl: output.repoUrl,
      prUrl: output.prUrl,
      branch: output.branch,
      files: output.files.length,
    });
    await log(output.prUrl ? `Opened ${output.prUrl}` : `Published ${output.repoUrl}`);
    return { status: 'SUCCESS', link: output.prUrl ?? output.repoUrl, result: { ...output, pullRequest: output.prUrl, number: number ?? null } };
  }
}
