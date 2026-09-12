import { reactive, watch } from 'vue';
import { ui } from './ui.js';

/**
 * Every key the reader answers to, in one list.
 *
 * WHY A REGISTRY. Bindings that live inside their own handlers cannot be
 * shown to the user, let alone changed by them -- and half of them were
 * only discoverable by reading the source. Every handler now asks this
 * module whether an event is its action, so the menu can rewrite the
 * answer and the whole scheme is legible in one place.
 *
 * ESCAPE IS NOT LISTED TWICE. It opens the menu, but it also puts a held
 * book back -- and before that it cancels a rebind. Rather than three
 * actions fighting over one key, Escape is a stack handled in one place;
 * see ui/mountMenu.js.
 *
 * KEYS ARE PHYSICAL (event.code), not characters. `KeyW` is the key west
 * of E whatever the layout prints on it, which is what a movement scheme
 * wants; `event.key` would put a French keyboard's W under Z. The cost is
 * that codes need prettifying for display -- see `label`.
 */

// Modifiers report which side was pressed. A binding on one should answer
// to both, so both the stored code and the incoming event are reduced to
// the bare modifier before they are compared.
const SIDED = /^(Shift|Control|Alt|Meta)(Left|Right)$/;

function normalise(code) {
  const sided = SIDED.exec(String(code ?? ''));
  return sided ? sided[1] : String(code ?? '');
}

/**
 * The actions, in the order the menu lists them. `group` is only a
 * heading; `id` is what handlers ask for and what is persisted.
 */
export const ACTIONS = [
  { id: 'menu.toggle', group: 'General', label: 'Open / close menu', default: 'Escape' },
  { id: 'audio.mute', group: 'General', label: 'Mute', default: 'KeyM' },
  { id: 'room.walls', group: 'General', label: 'Show / hide walls and ceiling', default: 'KeyH' },

  { id: 'camera.orbit', group: 'Camera', label: 'Orbit view', default: 'Digit1' },
  { id: 'camera.walk', group: 'Camera', label: 'Walk (first person)', default: 'Digit2' },
  { id: 'camera.look', group: 'Camera', label: 'Look from the middle', default: 'Digit3' },

  { id: 'move.forward', group: 'Movement', label: 'Forward', default: 'KeyW' },
  { id: 'move.back', group: 'Movement', label: 'Back', default: 'KeyS' },
  { id: 'move.left', group: 'Movement', label: 'Left', default: 'KeyA' },
  { id: 'move.right', group: 'Movement', label: 'Right', default: 'KeyD' },
  { id: 'move.run', group: 'Movement', label: 'Run', default: 'ShiftLeft' },
  { id: 'move.jump', group: 'Movement', label: 'Jump (walk)', default: 'Space' },

  { id: 'book.pageForward', group: 'Book', label: 'Turn forward', default: 'ArrowRight' },
  { id: 'book.pageBack', group: 'Book', label: 'Turn back', default: 'ArrowLeft' },
  { id: 'book.flip', group: 'Book', label: 'Flip the book over', default: 'KeyF' },
  { id: 'book.reset', group: 'Book', label: 'Reset the book (on the desk, or square in your hand)', default: 'KeyR' },

  { id: 'debug.labels', group: 'Debug', label: 'Hinge labels', default: 'Backquote' },
  { id: 'debug.pause', group: 'Debug', label: 'Pause the simulation', default: 'KeyP' },
];

const STORAGE_KEY = 'athenaeum.keybindings';

export const keys = reactive(
  Object.fromEntries(ACTIONS.map((action) => [action.id, action.default])),
);

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  // Read action by action rather than merging wholesale: a binding that was
  // saved and then removed from ACTIONS should not linger, and a new action
  // added since must come up on its default rather than undefined.
  for (const action of ACTIONS) {
    if (typeof saved[action.id] === 'string') keys[action.id] = saved[action.id];
  }
  // An action the save has never heard of was added since it was written, and
  // its default may be a key the save still gives something else -- Space
  // paused the simulation before it jumped. The older action moves to its own
  // default rather than both answering to one key.
  for (const action of ACTIONS) {
    if (action.id in saved) continue;
    const clash = ACTIONS.find(
      (other) => other.id !== action.id && normalise(keys[other.id]) === normalise(action.default),
    );
    if (clash && normalise(keys[clash.id]) !== normalise(clash.default)) keys[clash.id] = clash.default;
  }
} catch {
  // Private browsing, cleared storage, or a half-written value: defaults.
}

watch(keys, () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Not being able to remember a binding is not worth breaking over.
  }
}, { deep: true });

/**
 * Is this event that action?
 *
 * Two things are refused here rather than in every handler: keys pressed
 * while typing into a field, and -- for everything but the menu toggle --
 * keys pressed while the menu is open. The menu is a conversation with the
 * interface, not with the room.
 */
export function matches(actionId, event) {
  // The toggle is exempt from both guards: it is how you leave the menu,
  // and a slider having focus must not be able to trap you in it.
  const isToggle = actionId === 'menu.toggle';
  if (ui.menuOpen && !isToggle) return false;
  const tag = event.target instanceof HTMLElement ? event.target.tagName : '';
  if (!isToggle && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return normalise(event.code) === normalise(keys[actionId]);
}

/**
 * Is `code` the key this action is on? The bare comparison, without any of
 * the guards `matches` applies -- for keyUP, where a key released after the
 * menu opened still has to end whatever it started.
 */
export function isBound(actionId, code) {
  return normalise(code) === normalise(keys[actionId]);
}

/**
 * Point an action at a key. If another action already had it the two swap,
 * which keeps every action bound to something -- an action silently left
 * with no key is a worse outcome than a scheme the user has to think about
 * for a second.
 */
export function bind(actionId, code) {
  const previous = keys[actionId];
  const clash = ACTIONS.find((a) => a.id !== actionId && normalise(keys[a.id]) === normalise(code));
  if (clash) keys[clash.id] = previous;
  keys[actionId] = code;
}

export function resetBindings() {
  for (const action of ACTIONS) keys[action.id] = action.default;
}

const NAMED = {
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backquote: '`',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: '⌫',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
};

/** A code as it should be printed on a key cap. */
export function label(code) {
  const key = String(code ?? '');
  if (!key) return '—';
  if (NAMED[key]) return NAMED[key];
  if (key.startsWith('Key')) return key.slice(3);
  if (key.startsWith('Digit')) return key.slice(5);
  if (key.startsWith('Numpad')) return `Num ${key.slice(6)}`;
  return normalise(key);
}