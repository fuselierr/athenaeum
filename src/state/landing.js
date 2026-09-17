import { reactive } from 'vue';

/**
 * The welcome page: what a visitor who is not signed in sees instead of the
 * room (ui/LandingScreen.vue).
 *
 * Transient, like state/ui.js -- whether the welcome is up is decided fresh
 * every visit, from whether anyone is signed in. What it is DOING while a
 * book opens is not here either: that is the loader's own progress, in
 * state/book.js's `status` and `loading`, and the page reads it there
 * rather than keeping a second copy that could disagree.
 */
export const landing = reactive({
  /** True while the welcome is over the room. */
  showing: false,

  /** Why the book they chose did not open, or '' -- shown on the page. */
  error: '',
});
