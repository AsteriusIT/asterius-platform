#!/usr/bin/env node
// Fake `tofu` for the plan service tests: init / plan -out / show -json / version, with a plan computed from the spec.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

const args = process.argv.slice(2);
const log = process.env.FAKE_TOFU_LOG;
if (log)
  fs.appendFileSync(
    log,
    `${JSON.stringify({ args, cwd: process.cwd(), pat: process.env.AZDO_PERSONAL_ACCESS_TOKEN ?? null, org: process.env.AZDO_ORG_SERVICE_URL ?? null, cache: process.env.TF_PLUGIN_CACHE_DIR ?? null })}\n`,
  );
const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};

switch (args[0]) {
  case 'version':
    process.stdout.write(JSON.stringify({ terraform_version: '1.10.8' }));
    break;
  case 'init': {
    const override = fs.readFileSync(path.join(process.cwd(), 'zz_plan_service_override.tf'), 'utf8');
    if (!override.includes('backend "local"')) fail('Error: the backend must be local');
    if (!fs.existsSync(path.join(process.cwd(), 'main.tf'))) fail('Error: no configuration files');
    process.stdout.write('OpenTofu has been successfully initialized!\n');
    break;
  }
  case 'plan': {
    const out = args.find((a) => a.startsWith('-out='))?.slice(5);
    const specVar = args[args.indexOf('-var') + 1];
    const spec = YAML.parse(fs.readFileSync(specVar.slice(specVar.indexOf('=') + 1), 'utf8'));
    const name = spec.metadata.name;
    const team = spec.spec.owner;
    if (name === 'boom') fail(`Error: Invalid value for variable\n  token ${process.env.AZDO_PERSONAL_ACCESS_TOKEN} rejected`);
    if (name === 'slow') {
      const until = Date.now() + 5000;
      while (Date.now() < until);
    }
    const existing = name === 'existing';
    const resource_changes = [
      { address: 'data.azuredevops_projects.lookup', mode: 'data', type: 'azuredevops_projects', change: { actions: ['read'] } },
      {
        address: 'module.golden_path.azuredevops_project.this',
        mode: 'managed',
        type: 'azuredevops_project',
        name: 'this',
        change: existing
          ? { actions: ['no-op'], before: { name: `${team}-${name}` }, after: { name: `${team}-${name}` }, importing: { id: 'p-guid' } }
          : { actions: ['create'], before: null, after: { name: `${team}-${name}` }, after_unknown: { id: true } },
      },
      {
        address: 'module.golden_path.azuredevops_git_repository.this',
        mode: 'managed',
        type: 'azuredevops_git_repository',
        change: existing
          ? { actions: ['update'], before: { name }, after: { name }, importing: { id: 'r-guid' } }
          : { actions: ['create'], after: { name }, after_unknown: {} },
      },
      {
        address: 'module.golden_path.azuredevops_build_definition.ci',
        mode: 'managed',
        type: 'azuredevops_build_definition',
        change: { actions: ['create'], after: {}, after_unknown: { name: true } },
      },
      ...(spec.spec.environments ?? []).map((e) => ({
        address: `module.golden_path.azuredevops_environment.env["${e}"]`,
        mode: 'managed',
        type: 'azuredevops_environment',
        change: { actions: existing ? ['delete', 'create'] : ['create'], before: existing ? { name: e } : null, after: { name: e } },
      })),
    ];
    fs.writeFileSync(path.join(process.cwd(), out), JSON.stringify({ format_version: '1.2', terraform_version: '1.10.8', resource_changes }));
    process.stdout.write('Plan: n to add\n');
    break;
  }
  case 'show':
    process.stdout.write(fs.readFileSync(path.join(process.cwd(), args.at(-1)), 'utf8'));
    break;
  default:
    fail(`fake tofu: unknown command ${args[0]}`);
}
