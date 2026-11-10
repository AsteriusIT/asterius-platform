import os from 'node:os';
import path from 'node:path';

/**
 * Where the end-to-end stack lives. Its own ports (not 8080 / 5173) so it runs next to `npm run dev`; override with
 * E2E_API_PORT / E2E_WEB_PORT when they are taken.
 */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 18080);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 15173);
export const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;

/** Scratch directory: SQLite database, (empty) configuration directory, built web app, seed state. */
export const E2E_DIR = process.env.E2E_DIR ?? path.join(os.tmpdir(), 'asterius-e2e');
export const DATA_DIR = path.join(E2E_DIR, 'data');
export const CONFIG_DIR = path.join(E2E_DIR, 'config');
export const WEB_DIST = path.join(E2E_DIR, 'web');
export const SEED_FILE = path.join(E2E_DIR, 'seed.json');
