import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // Forwards /api/* from the Vite dev server to the Express
      // upload-server.ts process, so fetch('/api/books') from the browser
      // works without CORS headaches or hardcoding a port.
      '/api': 'http://localhost:3000',
    },
  },
});