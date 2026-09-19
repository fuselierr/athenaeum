import { reactive } from 'vue';

/**
 * The book controls laid over the screen (ui/BookControls.vue).
 *
 * Transient, like state/ui.js: whether they are up is this visit's business
 * and nothing is remembered between them.
 */
export const bookControls = reactive({
  /** True while the reader has them up. */
  showing: false,
});
