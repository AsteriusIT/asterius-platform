import fs from 'node:fs';

/**
 * Operations CLI (same image as the server, talks to the configured database):
 *   node dist/cli.js export [file]                          archive of definitions + entities (stdout by default)
 *   node dist/cli.js import <file> [--mode skip|overwrite] [--dry-run]
 *   node dist/cli.js rotate-secrets-key                     re-encrypt stored secrets with NEW_SECRETS_KEY (stop all pods first)
 * Exit code 0 on success, 1 on error (import: also when some items failed).
 */
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const option = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));

async function main(): Promise<number> {
  switch (command) {
    case 'export': {
      const { exportArchive } = await import('./archive.js');
      const text = JSON.stringify(await exportArchive());
      if (positional[0]) fs.writeFileSync(positional[0], text, { mode: 0o600 });
      else process.stdout.write(text + '\n');
      return 0;
    }
    case 'import': {
      const file = positional[0];
      const mode = option('mode') ?? 'skip';
      if (!file || (mode !== 'skip' && mode !== 'overwrite')) {
        console.error('usage: import <file> [--mode skip|overwrite] [--dry-run]');
        return 1;
      }
      const { importArchive } = await import('./archive.js');
      const report = await importArchive(JSON.parse(fs.readFileSync(file, 'utf8')), { mode, dryRun: flag('dry-run') });
      console.log(JSON.stringify(report, null, 2));
      return Object.values(report.failed).some((n) => n > 0) ? 1 : 0;
    }
    case 'reencrypt-secrets': {
      // Key rotation: add the new key at the head of SECRETS_KEYS, deploy, then run this (online, safe to repeat).
      const { reencryptSecrets } = await import('./secrets.js');
      const r = await reencryptSecrets();
      console.log(`re-encrypted ${r.reencrypted}/${r.total} secrets${r.failed.length ? `; FAILED: ${r.failed.join(', ')}` : ''}`);
      return r.failed.length ? 1 : 0;
    }
    default:
      console.error('commands: export [file] | import <file> [--mode skip|overwrite] [--dry-run] | reencrypt-secrets');
      return 1;
  }
}

try {
  const code = await main();
  const { closeDb } = await import('./db.js');
  await closeDb();
  process.exit(code);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
