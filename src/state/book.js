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

  /** [{ title, start }] -- `start` is 0..1 through the book's text. */
  chapters: [],

  /** What the loader is doing, or '' when there is nothing to say. */
  status: '',
  loading: false,
});

/** The page a chapter starts on, 1-based. See server/epubToc.ts. */
export function chapterPage(chapter) {
  if (!book.pageCount) return 1;
  return Math.min(book.pageCount, Math.max(1, Math.round(chapter.start * book.pageCount) + 1));
}