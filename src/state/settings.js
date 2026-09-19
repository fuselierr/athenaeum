import { reactive, watch } from 'vue';

/**
 * Everything the menu can change about the room, remembered between
 * visits.
 *
 * This module holds VALUES only. Nothing here reaches into the scene --
 * ui/bindSettings.js is what watches these and applies them, so the menu
 * can be built and reasoned about without a renderer, and the engine side
 * has exactly one place where a setting becomes an effect.
 */

const STORAGE_KEY = 'athenaeum.settings';

// Which shape of settings this is. Saved with them, so a copy written before a
// change of DEFAULT can be told apart from one where the reader chose the same
// value on purpose -- see migrate(). Bump it when a default changes and the
// old default should not be kept by everyone who happened to have it saved.
const SETTINGS_VERSION = 2;

export const settings = reactive({
  version: SETTINGS_VERSION,
  audio: {
    // 0..1. Master multiplies the other two; a channel at 0 is silent
    // whatever master says.
    master: 0.8,
    ambient: 0.5,
    sfx: 0.9,
    muted: true, // the room starts quiet until asked otherwise
  },
  camera: {
    lookSensitivity: 1, // multiplies the rig's own radians-per-pixel
    invertX: false, // flips which way a sideways drag turns the view
    invertY: false,
    fov: 70, // degrees, and the widest the LOOK mode will zoom back out to
  },
  graphics: {
    shadows: true,
    walls: true, // the walls and ceiling; hidden, the room opens onto the backdrop
    quality: 'high', // a state/quality.js preset: lowest, low, medium, high, highest
  },
  scene: {
    background: null, // a background id; null means the one built in
  },
  // Out of doors.
  outside: {
    // Hours, local solar time: where the sun is (scene/outside/sunPath.js).
    // 13.4 is the light the meadow was tuned in -- sunPath's DEFAULT_TIME.
    timeOfDay: 13.4,
  },
  // The shelf in the room. Not a look but an ORDER: how the books stand on it
  // (scene/inside/shelfBooks.js's arrange).
  shelf: {
    // 'shelf' as the library lists them, 'title', 'author' by the name as it is
    // written, or 'surname' by the name it would be filed under
    // (scene/inside/shelfOrder.js).
    sort: 'shelf',
    justify: 'left', // where the run of them sits: 'left', 'middle', 'right'
  },
});

/**
 * Merge saved values in field by field.
 *
 * Not a wholesale assign: a settings file written by an older version is
 * missing keys this one needs, and a newer one may carry keys this one has
 * never heard of. Only known fields, of the expected type, are taken.
 */
function restore(target, saved) {
  if (!saved || typeof saved !== 'object') return;
  for (const [key, value] of Object.entries(target)) {
    const incoming = saved[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) restore(value, incoming);
    else if (incoming !== undefined && typeof incoming === typeof value) target[key] = incoming;
    else if (value === null && (typeof incoming === 'string' || incoming === null)) {
      target[key] = incoming;
    }
  }
}

/**
 * Bring settings saved by an older version up to date before they are taken
 * in. Returns a copy; the saved object is left alone.
 *
 * WHY. Settings are saved whole whenever anything changes, and saved values
 * win over the defaults -- so a new default reaches nobody who has ever
 * touched a slider: their copy carries the OLD default as though they had
 * chosen it. Where a saved value is exactly an old default and the copy
 * predates the change, it was not a choice, and it is dropped so the new
 * default stands. From then on the copy carries this version, and the same
 * value is taken as meant.
 *
 *   version 1 -> 2  the field of view went from 50 to 70 degrees.
 */
function migrate(saved) {
  if (!saved || typeof saved !== 'object') return saved;
  const from = typeof saved.version === 'number' ? saved.version : 1;
  if (from >= SETTINGS_VERSION) return saved;
  const copy = { ...saved, camera: { ...(saved.camera ?? {}) } };
  if (from < 2 && copy.camera.fov === 50) delete copy.camera.fov;
  return copy;
}

/** Merge a saved copy in, brought up to date first, and stamp it current. */
function take(saved) {
  restore(settings, migrate(saved));
  settings.version = SETTINGS_VERSION;
}

/**
 * Take settings saved elsewhere -- the reader's account (auth/preferences.js)
 * -- in, field by field, exactly as this browser's own copy is taken in.
 */
export function applySettings(saved) {
  take(saved);
}

try {
  take(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
} catch {
  // Unreadable settings are no settings: the defaults above stand.
}

watch(settings, () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable; the session still works, it just forgets.
  }
}, { deep: true });