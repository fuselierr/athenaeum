import { reactive } from 'vue';

/**
 * Who is signed in, for the interface to read.
 *
 * Values only, like the other stores. auth/session.js is the one thing that
 * writes here; signing in and out are calls to it, not writes to this.
 */
export const account = reactive({
  /** Supabase's user object, or null when signed out. */
  user: null,

  /** False until the stored session has been read. Until then the corner
   *  shows nothing, rather than flashing "Sign in" at someone who is. */
  ready: false,

  /** False when the build carries no Supabase config at all. */
  available: true,

  /** A redirect to a sign-in provider, or a sign-out, is in flight. */
  busy: false,

  /** Which provider that redirect is heading to: 'google' | 'discord'. */
  provider: null,

  error: '',
});

/**
 * The name to show.
 *
 * Google puts the person's name in full_name. Discord puts the account's
 * USERNAME there, and the display name people actually know them by in
 * custom_claims.global_name -- so that comes first when it exists.
 */
export function displayName(user) {
  const meta = user?.user_metadata ?? {};
  return meta.custom_claims?.global_name || meta.full_name || meta.name || user?.email || 'Reader';
}