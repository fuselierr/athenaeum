import { createApp } from 'vue';
import AccountButton from './AccountButton.vue';
import { startSession } from '../auth/session.js';
import { account } from '../state/account.js';

/**
 * Put the top right corner's controls on screen -- the menu button, the
 * account and, outside, your books -- and load whoever is signed in.
 *
 * Separate from mountMenu: the menu is an overlay that comes and goes, and
 * this is always there. Its own host and its own app, so neither one's
 * lifetime is tied to the other's.
 *
 * @param {object} [bridge]  what the corner may ask of the room:
 *   takeBook(id), bring a library book into your hand (the books button
 *   outside, ui/LibraryButton.vue).
 * @returns {{ unmount(): void }}
 */
export function mountAccount(bridge = {}) {
  let host = document.getElementById('account');
  if (!host) {
    host = document.createElement('div');
    host.id = 'account';
    document.body.appendChild(host);
  }

  const app = createApp(AccountButton, { bridge });
  app.mount(host);

  // Not awaited: the room does not wait on the network to render, and the
  // control stays hidden until `account.ready` says which state to show.
  startSession().catch((err) => {
    console.error('Could not load the session:', err);
    account.error = err.message;
    account.ready = true; // show "Sign in" rather than nothing at all
  });

  return {
    unmount() {
      app.unmount();
    },
  };
}