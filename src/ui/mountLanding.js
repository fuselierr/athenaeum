import { createApp } from 'vue';
import LandingScreen from './LandingScreen.vue';

/**
 * Put the welcome page on screen -- what a visitor who is not signed in sees
 * instead of the room (ui/LandingScreen.vue).
 *
 * Its own host and its own app, like the corner's (ui/mountAccount.js): the
 * menu comes and goes, and neither of these should be tied to its lifetime.
 * Mounted on every visit and showing nothing until state/landing.js says so,
 * so the page is already built and styled the moment main.js decides a
 * visitor is not signed in -- there is no second load to wait through
 * between the loading screen lifting and the welcome appearing.
 *
 * @param {object} bridge  what the page may ask of the room:
 *   startWithBook(file), open an EPUB and go outside with it.
 * @returns {{ unmount(): void }}
 */
export function mountLanding(bridge = {}) {
  let host = document.getElementById('landing');
  if (!host) {
    host = document.createElement('div');
    host.id = 'landing';
    document.body.appendChild(host);
  }

  const app = createApp(LandingScreen, { bridge });
  app.mount(host);

  return {
    unmount() {
      app.unmount();
    },
  };
}
