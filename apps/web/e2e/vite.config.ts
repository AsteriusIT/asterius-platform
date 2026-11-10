import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';
import { API_PORT, WEB_DIST, WEB_PORT } from './support/env.ts';

/**
 * The web app for the end-to-end tests: a production build (what users get: no HMR, no dependency re-optimisation
 * reloading the page mid-test), served by `vite preview` on its own port and proxied to the test API server.
 */
let client = 0;
const proxy = {
  '/api': {
    target: `http://127.0.0.1:${API_PORT}`,
    changeOrigin: true,
    // The API allows 600 requests a minute per client address, which a parallel suite of ~100 page loads exceeds:
    // present the requests as coming from many clients (the server trusts X-Forwarded-For from loopback proxies).
    configure: (server: { on: (event: 'proxyReq', fn: (req: { setHeader: (name: string, value: string) => void }) => void) => void }) =>
      server.on('proxyReq', (req) => req.setHeader('x-forwarded-for', `10.99.${Math.floor(client / 250) % 250}.${(client++ % 250) + 1}`)),
  },
};

export default mergeConfig(
  base,
  defineConfig({
    build: { outDir: WEB_DIST, emptyOutDir: true },
    server: { port: WEB_PORT, strictPort: true, proxy },
    preview: { port: WEB_PORT, strictPort: true, host: '127.0.0.1', proxy },
  }),
);
