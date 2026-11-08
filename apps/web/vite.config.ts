import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Matches modules of exactly these packages (not `react-markdown` for `react`). */
const pkg = (...names: string[]) => new RegExp(`[\\\\/]node_modules[\\\\/](${names.map((n) => n.replace('/', '[\\\\/]')).join('|')})[\\\\/]`);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
  build: {
    rolldownOptions: {
      output: {
        // Long-cached vendor chunks, app code stays small.
        codeSplitting: {
          groups: [
            { name: 'react', test: pkg('react', 'react-dom', 'react-router', 'scheduler', '@tanstack/react-query') },
            { name: 'mantine', test: pkg('@mantine/core', '@mantine/hooks', '@mantine/notifications', '@mantine/modals') },
            { name: 'icons', test: pkg('@tabler/icons-react') },
            { name: 'markdown', test: pkg('react-markdown', 'remark-gfm') },
            { name: 'yaml', test: pkg('yaml') },
            // Service logos (~190 KB of SVG): cached separately from app code.
            { name: 'vendor-icons', test: /[\\/]src[\\/]components[\\/]vendorIcons\.generated\.ts$/ },
          ],
        },
      },
    },
  },
});
