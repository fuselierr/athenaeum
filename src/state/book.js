import { reactive } from 'vue';

/**
 * What the reader currently has open, for the menu to read.
 *
 * A mirror, not the source: bookContent owns the reading position and the
 * loader owns the rest. main.js pushes changes in here so the Book tab can
 * be a plain view over plain data, and navigation goes back the other way
 * as calls, not as writes to this object.
 */
export const book = reactive({
  id: null,
  title: null,
  author: null,

  pageCount: 0,
  page: 1, // 1-based, the left-hand page of the open spread

  /**
   * The book's chapters. Either [{ title, page }] once it has been opened
   * and its pages are known exactly, or [{ title, start }] -- `start` is
   * 0..1 through the book's text -- while it is still just off the shelf.
   * chapterPage() below takes whichever is there.
   */
  chapters: [],

  /** What the loader is doing, or '' when there is nothing to say. */
  status: '',
  loading: false,
});

/**
 * The page a chapter starts on, 1-based.
 *
 * Two kinds of chapter arrive here and both are handled, because they
 * arrive at different moments. Picking a book off the shelf brings the
 * library's estimate with it (`start`, a fraction of the book's text --
 * see server/epubToc.ts), so the Book tab is populated before the book has
 * even opened. Opening it replaces those with the pages the converter
 * actually measured (`page` -- see server/epubToPdf.ts), which are exact.
 */
export function chapterPage(chapter) {
  if (!book.pageCount) return 1;
  const page = Number.isFinite(chapter.page)
    ? chapter.page
    : Math.round(chapter.start * book.pageCount) + 1;
  return Math.min(book.pageCount, Math.max(1, page));
}