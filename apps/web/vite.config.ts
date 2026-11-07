import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
  build: {
    rollupOptions: {
      output: {
        // Long-cached vendor chunks, app code stays small.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router', '@tanstack/react-query'],
          mantine: ['@mantine/core', '@mantine/hooks', '@mantine/notifications', '@mantine/modals'],
          icons: ['@tabler/icons-react'],
          markdown: ['react-markdown', 'remark-gfm'],
          yaml: ['yaml'],
          // Service logos (~190 KB of SVG): cached separately from app code.
          'vendor-icons': ['./src/components/vendorIcons.generated.ts'],
        },
      },
    },
  },
});
