import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// The browser only ever talks to its own origin. In development Vite forwards
// /api to the Django backend, so session and CSRF cookies are first-party and
// no CORS configuration is needed. In production, serve the built files and
// route /api to Django from the same host.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.FINTRACE_API_PROXY_TARGET || 'http://127.0.0.1:8000';

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 3000,
      strictPort: true,
      proxy: {
        '/api': { target: backend, changeOrigin: false },
      },
    },
  };
});
