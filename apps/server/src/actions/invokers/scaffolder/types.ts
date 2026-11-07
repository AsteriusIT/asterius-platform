import type { ScaffoldConfig } from './config.js';

/** A file read from the template repository (`content` is base64). */
export interface TemplateFile {
  path: string;
  content: string;
}
/** A rendered file ready to be committed (`content` is base64). */
export type Rendered = TemplateFile;

/**
 * Stable output of the scaffolder (the run result, usable as `{{ steps.<id>.output.prUrl }}`).
 * The invoker also returns `pullRequest` (= prUrl) and `number` (PR/MR number) for compatibility.
 */
export interface ScaffoldOutput {
  /** Web URL of the repository that received the files. */
  repoUrl: string;
  /** Web URL of the pull / merge request; null when no PR is opened. */
  prUrl: string | null;
  /** Branch that holds the scaffolded files. */
  branch: string;
  /** Sha of the commit at the tip of that branch ('' if the provider did not report it). */
  commit: string;
  provider: ScaffoldConfig['provider'];
  /** Paths of the committed files, relative to the repository root. */
  files: string[];
}

/** What a publisher returns: the output plus the PR/MR number (kept for compatibility). */
export type PublishResult = ScaffoldOutput & { number?: number | null };

export interface PublishContext {
  /** Validated and rendered configuration. */
  config: ScaffoldConfig;
  files: Rendered[];
  branch: string;
  title: string;
  /** Pull request description. */
  body: string;
}

/**
 * One implementation per provider (`github.ts`, `gitlab.ts`, …), registered in `index.ts`.
 * `publish` branches on `ctx.config.mode`; modes it does not implement throw `unsupportedMode(provider, mode)`.
 */
export interface ScaffoldPublisher {
  provider: ScaffoldConfig['provider'];
  /** Modes this publisher implements (checked before the template is read). */
  modes: readonly ScaffoldConfig['mode'][];
  /** Read the template files (restricted to `templatePath`, limits enforced). */
  readTemplate(config: ScaffoldConfig): Promise<TemplateFile[]>;
  publish(ctx: PublishContext): Promise<PublishResult>;
}
