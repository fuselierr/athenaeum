import { reactive } from 'vue';

/**
 * The card of book controls held over the book (ui/BookControls.vue).
 *
 * Transient, like state/ui.js: whether it is up is this visit's business and
 * nothing is remembered between them.
 *
 * WHERE the card sits is deliberately NOT here. The book's place on screen
 * changes every frame -- it is carried, turned, walked around -- and writing
 * that into a reactive object sixty times a second would wake Vue on every
 * one of them for a number that only moves a panel. The frame loop writes it
 * straight to CSS custom properties instead (ui/bookAnchor.js) and the card
 * positions itself from those. Only `onScreen` comes back this way, because
 * it changes when the book leaves the view and not otherwise.
 */
export const bookControls = reactive({
  /** True while the reader has the card up. */
  showing: false,

  /**
   * Whether there is a book in view to hold it over. False with nothing
   * open, or when the book is behind you -- the card comes down rather than
   * hanging in a corner pointing at nothing, and goes back up when the book
   * does.
   */
  onScreen: false,
});
