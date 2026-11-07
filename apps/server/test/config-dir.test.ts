import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfigDir } from '../src/config-loader.js';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'asterius-config-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const TEAMS = 'teams:\n  - { identifier: ops, title: Ops }\n';
const BLUEPRINTS = JSON.stringify({ blueprints: [{ identifier: 'db', title: 'Database', schema: { properties: {} } }] });

describe('readConfigDir', () => {
  it('reads a Kubernetes ConfigMap volume once (files are symlinks into ..data)', () => {
    // Layout written by the kubelet: ..<timestamp>/<files>, ..data -> ..<timestamp>, <file> -> ..data/<file>
    const dir = tmp();
    const stamp = '..2026_11_07_14_30_27.3302447085';
    fs.mkdirSync(path.join(dir, stamp));
    fs.writeFileSync(path.join(dir, stamp, 'teams.yaml'), TEAMS);
    fs.writeFileSync(path.join(dir, stamp, 'catalog.json'), BLUEPRINTS);
    fs.symlinkSync(stamp, path.join(dir, '..data'));
    fs.symlinkSync(path.join('..data', 'teams.yaml'), path.join(dir, 'teams.yaml'));
    fs.symlinkSync(path.join('..data', 'catalog.json'), path.join(dir, 'catalog.json'));

    const loaded = readConfigDir(dir);
    expect(loaded.files.map((f) => path.basename(f))).toEqual(['catalog.json', 'teams.yaml']);
    expect(loaded.data.teams.map((t) => t.identifier)).toEqual(['ops']);
    expect(loaded.data.blueprints.map((b) => b.identifier)).toEqual(['db']);
  });

  it('skips hidden directories and links pointing outside the directory', () => {
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'secret.yaml'), 'teams:\n  - { identifier: leaked, title: Leaked }\n');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'teams.yaml'), TEAMS);
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'config.yaml'), TEAMS);
    fs.symlinkSync(path.join(outside, 'secret.yaml'), path.join(dir, 'escape.yaml'));
    fs.symlinkSync(path.join(dir, 'missing.yaml'), path.join(dir, 'dangling.yaml'));

    const loaded = readConfigDir(dir);
    expect(loaded.files.map((f) => path.basename(f))).toEqual(['teams.yaml']);
    expect(loaded.data.teams.map((t) => t.identifier)).toEqual(['ops']);
  });
});
