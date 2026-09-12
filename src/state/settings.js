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

export const settings = reactive({
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
    fov: 50, // degrees, and the widest the LOOK mode will zoom back out to
  },
  graphics: {
    shadows: true,
    walls: true, // the walls and ceiling; hidden, the room opens onto the backdrop
  },
  scene: {
    background: null, // a background id; null means the one built in
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

try {
  restore(settings, JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
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