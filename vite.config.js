import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      // Forwards /api/* from the Vite dev server to the Express
      // server/uploadServer.ts process, so fetch('/api/books') from the
      // browser works without CORS headaches or hardcoding a port.
      '/api': 'http://localhost:3000',
    },
  },
});