import type { Rendered, TemplateFile } from './types.js';

export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

export function checkLimits(sizes: number[]) {
  if (sizes.length > MAX_FILES) throw new Error(`template has ${sizes.length} files (max ${MAX_FILES})`);
  if (sizes.some((s) => s > MAX_FILE_BYTES)) throw new Error(`a template file is larger than ${MAX_FILE_BYTES} bytes`);
  if (sizes.reduce((a, b) => a + b, 0) > MAX_TOTAL_BYTES) throw new Error('template is too large');
}

export const prefix = (p: string | undefined) => (p ?? '').replace(/^\/+|\/+$/g, '');
export const underPrefix = (path: string, pre: string) => (pre ? path.startsWith(`${pre}/`) : true);

/** Replace `{{ name }}` / `{{ cookiecutter.name }}`; an unknown variable is an error (a typo would ship). */
export function renderText(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(?:cookiecutter\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`template variable "${name}" is not provided`);
    return vars[name]!;
  });
}

/** Render paths and text contents; binary files are copied as is. Rejects unsafe rendered paths. */
export function renderFiles(files: TemplateFile[], vars: Record<string, string>, targetDir: string): Rendered[] {
  const dir = targetDir.replace(/^\/+|\/+$/g, '');
  return files.map((f) => {
    const rendered = renderText(f.path, vars);
    const path = [dir && dir !== '.' ? dir : '', rendered].filter(Boolean).join('/');
    if (path.split('/').some((seg) => seg === '..' || seg === '') || path.startsWith('/')) throw new Error(`unsafe path in template: "${rendered}"`);
    const raw = Buffer.from(f.content, 'base64');
    if (raw.includes(0)) return { path, content: f.content }; // binary
    return { path, content: Buffer.from(renderText(raw.toString('utf8'), vars)).toString('base64') };
  });
}

/** Error for a provider/mode combination without an implementation yet. */
export const unsupportedMode = (provider: string, mode: string) => new Error(`scaffolder: mode "${mode}" is not supported yet for provider ${provider}`);
