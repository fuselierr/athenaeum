import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  // The same .env the server reads, loaded with no prefix filter so its
  // variable names can stay the ones the server already uses. Then only the
  // public values go to the browser, each by name. Not envPrefix: a SUPABASE_
  // prefix would put SUPABASE_SECRET_KEY on import.meta.env too, and the
  // secret key must never end up in a bundle.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [vue()],
    define: {
      // Public by design -- row-level security guards the data, not these.
      // Read by src/auth/session.js.
      __SUPABASE_URL__: JSON.stringify(env.SUPABASE_URL ?? ''),
      __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(env.SUPABASE_PUBLISHABLE_KEY ?? ''),
      // Where the conversion server lives once it is not this origin -- set on
      // the deployed site, e.g. https://athenaeum-server.up.railway.app. Left
      // unset in development, where /api is proxied (below). Read by
      // src/loader/api.js.
      __ATHENAEUM_API_URL__: JSON.stringify(env.ATHENAEUM_API_URL ?? ''),
    },
    server: {
      proxy: {
        // Forwards /api/* from the Vite dev server to the Express
        // server/uploadServer.ts process, so fetch('/api/books') from the
        // browser works without CORS headaches or hardcoding a port.
        '/api': 'http://localhost:3000',
      },
    },
  };
});