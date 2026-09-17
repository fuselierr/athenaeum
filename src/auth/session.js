import { createClient } from '@supabase/supabase-js';
import { account } from '../state/account.js';

/**
 * The reader's account: a browser Supabase client, the session it keeps,
 * and signing in and out.
 *
 * WHICH KEYS REACH THE BROWSER. The project URL and the PUBLISHABLE key,
 * and nothing else. They are injected at build time as __SUPABASE_URL__
 * and __SUPABASE_PUBLISHABLE_KEY__ (see vite.config.js), which hands those
 * two over by name. Both are public by design -- row-level security is
 * what protects data, not the key. The secret key in the same .env belongs
 * to the server and is never referenced from here.
 *
 * ACCOUNTS. There is no separate sign-up. The first time someone signs in
 * -- with Google or with Discord -- Supabase Auth creates their user
 * (auth.users) itself; every sign-in after that finds the same user.
 *
 * PROVIDERS. Each one offered here must ALSO be switched on under
 * Authentication -> Sign In / Providers in the Supabase dashboard, or
 * Supabase refuses with "provider is not enabled". Nothing in this file
 * can tell whether it has been.
 *
 * THE REDIRECT. Signing in leaves the page for the provider's and comes
 * back to it with a one-time code in the URL (PKCE). detectSessionInUrl has supabase-js
 * exchange that code for a session as it loads, and persistSession keeps
 * the session in localStorage so a reload stays signed in.
 */

// `typeof` rather than a bare read: if the build did not define these (a
// config that predates them), a bare identifier would throw on load and
// take the whole room down with it, where this just leaves sign-in off.
const url = typeof __SUPABASE_URL__ === 'string' ? __SUPABASE_URL__ : '';
const key = typeof __SUPABASE_PUBLISHABLE_KEY__ === 'string' ? __SUPABASE_PUBLISHABLE_KEY__ : '';

export const supabase = url && key
  ? createClient(url, key, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  : null;

/**
 * Read the stored session, and keep `account` in step with every change
 * after -- a sign-in returning from Google, a token refresh, a sign-out.
 */
export async function startSession() {
  if (!supabase) {
    account.available = false;
    account.error = 'Sign-in is not configured: SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are missing from .env.';
    account.ready = true;
    return;
  }

  // Subscribed before the first read, so a change landing while the stored
  // session loads is not lost between the two. Nothing async is awaited
  // inside the callback: supabase-js holds a lock while it runs, and
  // calling back into auth from there can deadlock.
  let heard = false; // whether a change has already said who is signed in
  supabase.auth.onAuthStateChange((_event, session) => {
    heard = true;
    account.user = session?.user ?? null;
    account.ready = true;
  });

  const { data, error } = await supabase.auth.getSession();
  if (error) account.error = error.message;
  // ONLY IF NOTHING HAS BEEN HEARD SINCE. Coming back from a provider, the
  // one-time code in the URL is exchanged for the new session while this read
  // is in flight -- and this read is of the session STORED BEFORE it, which is
  // the account that was signed in last time. The exchange lands on the
  // listener above with the right user; letting this overwrite it is how
  // signing in as somebody else leaves the old name in the corner until you
  // sign out and in again.
  if (!heard) account.user = data?.session?.user ?? null;
  account.ready = true;
}

/**
 * Leave for a provider's sign-in page -- 'google' or 'discord'. Comes back
 * to this same page either way.
 */
export async function signInWith(provider) {
  if (!supabase) return;
  account.busy = true;
  account.provider = provider;
  account.error = '';
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      // Back to exactly this page. It must also be allowed under Redirect
      // URLs in the Supabase dashboard, or Supabase sends the reader to the
      // project's Site URL instead.
      redirectTo: `${window.location.origin}${window.location.pathname}`,
      // ASK WHICH ACCOUNT. Google signs straight back in as whoever was last
      // used when it is not asked, which is exactly wrong for someone who has
      // just signed out in order to sign in as somebody else: they never see a
      // chooser, and land back in the account they were leaving. (Discord has
      // no equivalent -- switching there means signing out of Discord itself.)
      ...(provider === 'google' ? { queryParams: { prompt: 'select_account' } } : {}),
    },
  });
  // On success the browser is already on its way to the provider, so only
  // a failure is ever handled here.
  if (error) {
    account.error = error.message;
    account.busy = false;
    account.provider = null;
  }
}

// Pressing Back on the provider's page can restore this one from the
// browser's back/forward cache exactly as it was left -- mid-"Opening…",
// buttons disabled, and nothing left running that would ever re-enable
// them.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  account.busy = false;
  account.provider = null;
});

export async function signOut() {
  if (!supabase) return;
  account.busy = true;
  account.error = '';
  const { error } = await supabase.auth.signOut();
  if (error) account.error = error.message;
  account.busy = false;
}