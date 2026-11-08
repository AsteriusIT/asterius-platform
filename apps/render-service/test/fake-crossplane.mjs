#!/usr/bin/env node
// Stand-in for `crossplane render` in tests: echoes the XR and one composed resource per Function of functions.yaml.
import fs from 'node:fs';
import process from 'node:process';
import YAML from 'yaml';

const [, , cmd, xrFile, , fnFile] = process.argv;
if (cmd !== 'render') process.exit(2);
const xr = YAML.parse(fs.readFileSync(xrFile, 'utf8'));
if (xr.metadata.name === 'boom') {
  process.stderr.write('crossplane: error: cannot run pipeline step\n');
  process.exit(1);
}
const fns = YAML.parseAllDocuments(fs.readFileSync(fnFile, 'utf8')).map((d) => d.toJS());
const out = [{ apiVersion: xr.apiVersion, kind: xr.kind, metadata: { name: xr.metadata.name }, status: {} }];
for (const f of fns)
  out.push({
    apiVersion: 'example.org/v1',
    kind: 'Thing',
    metadata: {
      generateName: `${xr.metadata.name}-`,
      annotations: {
        'crossplane.io/composition-resource-name': f.metadata.name,
        'crossplane.io/external-name': `${xr.spec.owner}-${xr.metadata.name}`,
        target: f.metadata.annotations['render.crossplane.io/runtime-development-target'],
      },
    },
  });
out.push({ apiVersion: 'render.crossplane.io/v1beta1', kind: 'Result', severity: 'SEVERITY_NORMAL', message: 'ok' });
process.stdout.write(out.map((o) => YAML.stringify(o)).join('---\n'));
