import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import { errorMessage } from './lib/errors.js';
import { registerInvoker } from './actions/invokers/index.js';
import { registerSource } from './integrations/sources/index.js';
import type { Invoker } from './actions/types.js';
import type { Source } from './integrations/types.js';

/**
 * In-process plugins: ES modules that add source and invoker types without forking the platform.
 *   PLUGIN_DIR   a directory (default ./plugins next to CONFIG_DIR's parent when it exists): every `*.mjs` / `*.js`
 *                file and every sub-directory with an `index.mjs` / `index.js` / package.json `main` is loaded
 *   PLUGINS      comma separated package names or paths installed in the image (`@acme/asterius-plugin-jira`)
 * A module default-exports (or exports `register`) a function receiving the `PluginApi`.
 * Plugins run with the full privileges of the server: install only code you trust. For untrusted or non-Node
 * code use the out-of-process `external` source / invoker (docs/EXTENDING.md).
 */

export interface PluginApi {
  apiVersion: 1;
  registerSource(source: Source): void;
  registerInvoker(invoker: Invoker): void;
  log: FastifyBaseLogger;
}

export const PLUGIN_API_VERSION = 1;

type PluginModule = { default?: unknown; register?: unknown };

function candidates(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isFile() && /\.(mjs|js)$/.test(e.name)) out.push(p);
    else if (e.isDirectory()) {
      let main: string | undefined;
      try {
        main = (JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')) as { main?: string }).main;
      } catch {
        /* no package.json */
      }
      const entry = [main, 'index.mjs', 'index.js']
        .filter((x): x is string => !!x)
        .map((x) => path.join(p, x))
        .find((x) => fs.existsSync(x));
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** Load plugins; a broken plugin is reported and skipped (it must not take the platform down). Returns the loaded ones. */
export async function loadPlugins(log: FastifyBaseLogger, opts: { dir?: string; packages?: string[] } = {}): Promise<string[]> {
  const dir = opts.dir ?? config.PLUGIN_DIR;
  const specs = [
    ...(dir ? candidates(path.resolve(dir)).map((p) => ({ name: path.relative(path.resolve(dir), p), url: pathToFileURL(p).href })) : []),
    ...(
      opts.packages ??
      config.PLUGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ).map((s) => ({
      name: s,
      url: s.startsWith('.') || path.isAbsolute(s) ? pathToFileURL(path.resolve(s)).href : s,
    })),
  ];
  const loaded: string[] = [];
  for (const spec of specs) {
    try {
      const mod = (await import(spec.url)) as PluginModule;
      const register = typeof mod.register === 'function' ? mod.register : typeof mod.default === 'function' ? mod.default : undefined;
      if (!register) throw new Error('no default export or `register` function');
      const api: PluginApi = {
        apiVersion: PLUGIN_API_VERSION,
        registerSource: (s) => {
          checkInfo(s.info, 'source');
          registerSource(s);
        },
        registerInvoker: (i) => {
          checkInfo(i.info, 'invoker');
          registerInvoker(i);
        },
        log,
      };
      await (register as (api: PluginApi) => unknown)(api);
      loaded.push(spec.name);
      log.info(`plugin loaded: ${spec.name}`);
    } catch (err) {
      log.error(`plugin ${spec.name} failed to load: ${errorMessage(err)}`);
    }
  }
  return loaded;
}

function checkInfo(info: { type?: string; title?: string; example?: unknown } | undefined, what: string) {
  if (!info?.type || !/^[a-z][a-z0-9-]{0,63}$/.test(info.type)) throw new Error(`${what}: info.type must be lowercase letters, digits and -`);
  if (!info.title || !info.example) throw new Error(`${what} ${info.type}: info.title and info.example are required`);
}
