/**
 * Write the OpenAPI document: npm run openapi:export [file]   (default docs/openapi.json)
 * Clients: npx openapi-typescript docs/openapi.json -o client.ts · openapi-python-client generate --path docs/openapi.json
 */
import fs from 'node:fs';
import path from 'node:path';

const { buildApp } = await import('../app.js');
const { closeDb } = await import('../db.js');
const app = await buildApp();
const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
const file = path.resolve(process.argv[2] ?? '../../docs/openapi.json');
fs.writeFileSync(file, `${JSON.stringify(res.json(), null, 2)}\n`);
console.log(`wrote ${file}`);
await app.close();
await closeDb();
