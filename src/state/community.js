import { reactive } from 'vue';

/**
 * Shared covers, for the Community tab to read.
 *
 * Values only, like the other stores. community/covers.js writes the
 * attachments; main.js fills in the books from the shelf and dresses the
 * shelf to match whatever the attachments say.
 */
export const community = reactive({
  /**
   * Your books -- the shelf's -- as `{ id, title, author, size }`, size in
   * metres. Empty until the shelf has loaded.
   */
  books: [],

  /**
   * Which shared cover each of your books wears, by book id, as a design
   * (see toDesign in community/covers.js). A book not in here wears its
   * own. Replaced whole on every change, never edited in place, so a
   * watcher on it hears each one.
   */
  attachments: {},

  /** Why your covers could not be read, or ''. */
  error: '',
});
