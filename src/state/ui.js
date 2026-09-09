import { reactive } from 'vue';

/**
 * What the menu itself is doing. Kept apart from the settings it edits,
 * because this is transient -- nothing here is worth remembering between
 * visits, and the 3D side reads `menuOpen` to know it is not being talked
 * to (see keybindings.matches).
 */
export const ui = reactive({
  menuOpen: false,
  tab: 'book',
  /** True while the Settings tab is waiting for a key to bind. */
  capturingKey: false,
});