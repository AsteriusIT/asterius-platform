/**
 * Validate a configuration directory without a database or a running server (pull request checks):
 *   npm run config:validate -- [dir]
 * Checks the schemas, duplicate identifiers, source configuration, templates, mappings and expressions.
 * Exits 1 when anything is wrong.
 */
import path from 'node:path';
import { readConfigDir } from '../config-loader.js';
import { checkExpression, checkTemplate } from '../lib/expr.js';
import { errorMessage } from '../lib/errors.js';
import { getSource } from '../integrations/sources/index.js';
import { checkMapping } from '../integrations/mapping.js';
import { parseCron } from '../lib/cron.js';
import { expandWorkflow, validateFragment, type FragmentLookup } from '../actions/fragments.js';

const dir = path.resolve(process.argv[2] ?? process.env.CONFIG_DIR ?? './config');
const problems: string[] = [];
const check = (where: string, fn: () => void) => {
  try {
    fn();
  } catch (err) {
    problems.push(`${where}: ${errorMessage(err)}`);
  }
};

const checkAsync = async (where: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (err) {
    problems.push(`${where}: ${errorMessage(err)}`);
  }
};

let loaded;
try {
  loaded = readConfigDir(dir);
} catch (err) {
  console.error(`FAIL ${errorMessage(err)}`);
  process.exit(1);
}

const blueprints = new Set(loaded.data.blueprints.map((b) => b.identifier));
for (const i of loaded.data.integrations) {
  const where = `integration ${i.identifier}`;
  check(where, () => getSource(i.type).validate(i.config));
  check(where, () => checkTemplate(i.config));
  if (i.schedule) check(where, () => parseCron(i.schedule!));
  for (const m of i.mappings) {
    check(`${where} mapping ${m.kind}`, () => checkMapping(m));
    if (blueprints.size && !blueprints.has(m.entity.blueprint))
      console.warn(`WARN ${where}: blueprint "${m.entity.blueprint}" is not declared in these files (it must already exist)`);
  }
}
for (const w of loaded.data.webhooks)
  for (const [k, expr] of [
    ['filter', w.filter],
    ['transform', w.transform],
  ] as const)
    if (expr) check(`webhook ${w.identifier} ${k}`, () => checkExpression(expr));

// Fragments on their own (graph, outputs, parameters used), and inlined into the actions that include them.
const fragments = new Map(loaded.data.fragments.map((f) => [f.identifier, f]));
const lookup: FragmentLookup = async (id) => (fragments.has(id) ? { def: fragments.get(id)!, version: 0 } : undefined);
for (const f of loaded.data.fragments) await checkAsync(`fragment ${f.identifier}`, () => validateFragment(f, lookup));
for (const a of loaded.data.actions)
  if (a.steps.some((s) => s.type === 'fragment')) await checkAsync(`action ${a.identifier}`, () => expandWorkflow(a.steps, lookup));

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(
  `OK ${loaded.files.length} file(s): ${loaded.data.teams.length} teams, ${loaded.data.blueprints.length} blueprints, ${loaded.data.fragments.length} fragments, ${loaded.data.actions.length} actions, ${loaded.data.integrations.length} integrations, ${loaded.data.webhooks.length} webhooks`,
);
