import { createApp } from 'vue';
import MenuRoot from './menu/MenuRoot.vue';
import { ui } from '../state/ui.js';
import { matches } from '../state/keybindings.js';

/**
 * Put the menu on screen and give Escape its meaning.
 *
 * ESCAPE IS A STACK, innermost first. Holding a book, Escape puts it back;
 * with the menu open, Escape closes it; otherwise it opens the menu. That
 * is what `bridge.escape()` is for -- it returns true when the room
 * consumed the press, and only then does the menu stay out of it.
 *
 * The panel is an ordinary DOM overlay over the canvas, so pointer events
 * that land on it never reach the renderer and the camera cannot be dragged
 * through a slider. Keys need the explicit guard instead, which lives in
 * keybindings.matches: while the menu is open nothing but the toggle
 * matches, so no handler in the room has to know the menu exists.
 *
 * @param {object} bridge  what the tabs are allowed to do to the room:
 *   goToPage(page), turnPage(direction), setBackground(id), escape().
 * @returns {{ unmount(): void }}
 */
export function mountMenu(bridge) {
  let host = document.getElementById('menu');
  if (!host) {
    host = document.createElement('div');
    host.id = 'menu';
    document.body.appendChild(host);
  }

  const app = createApp(MenuRoot, { bridge });
  app.mount(host);

  function onKeyDown(event) {
    if (ui.capturingKey) return; // the Settings tab is listening for a key
    if (!matches('menu.toggle', event)) return;
    event.preventDefault();
    if (ui.menuOpen) {
      ui.menuOpen = false;
      return;
    }
    // Only reaches the menu if nothing more immediate wanted it.
    if (bridge.escape?.()) return;
    ui.menuOpen = true;
  }
  // Capture phase: Escape and Tab are both keys the browser and the room
  // have opinions about, and the menu's claim on them comes first.
  window.addEventListener('keydown', onKeyDown, { capture: true });

  return {
    unmount() {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      app.unmount();
    },
  };
}