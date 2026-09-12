import { supabase } from '../auth/session.js';
import { account } from '../state/account.js';
import { community } from '../state/community.js';

/**
 * Shared book covers: finding them, putting one on your own book, and
 * sharing your own.
 *
 * THE DATA is in Supabase (the tables, bucket, policies and search function
 * are set up in the project itself, not in this repo):
 *   cover_designs  one row per shared cover -- title, author, keywords, and
 *                  where its three images are stored
 *   library        one row per book of yours that has been given a cover:
 *                  the shelf book's id in epub_path, the cover in design_id
 *   cover-art      the storage bucket for the images, each reader's under a
 *                  folder named for their user id
 *
 * Straight from the browser, as the signed-in reader: row-level security is
 * what keeps one reader's library theirs. The one thing about other readers
 * anyone gets to know -- how many of them use a cover -- comes from the
 * search_cover_designs function, which counts without saying who.
 *
 * IMAGES are stored the way they are seen: the front and back as they face
 * you, and the spine standing up, head at the top, as it is seen shelved.
 * book/cover/bookModel.js turns each onto its face of the book.
 */

export const COVER_BUCKET = 'cover-art';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the bucket's own limit, too
const SEARCH_LIMIT = 40;
const MAX_KEYWORDS = 12;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const SETUP_NEEDED = 'Shared covers are not set up on this Supabase project: the '
  + 'search_cover_designs function or the cover-art storage bucket is missing.';

/** A Supabase error as something worth showing a reader. */
function failure(error) {
  const message = error?.message ?? String(error);
  // Nothing to search with, or nowhere to put the images: the SQL has not run.
  if (error?.code === 'PGRST202' || /bucket not found/i.test(message)) return new Error(SETUP_NEEDED);
  return new Error(message);
}

function requireSupabase() {
  if (!supabase) {
    throw new Error('Shared covers need Supabase: SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are missing from .env.');
  }
  return supabase;
}

function requireUser() {
  requireSupabase();
  if (!account.user) throw new Error('Sign in first.');
  return account.user;
}

/** A stored image path as a url anyone can load. */
function artUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return supabase.storage.from(COVER_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * A cover_designs row, as the rest of the app uses it:
 * `{ id, creatorId, title, author, keywords, front, spine, back, users, createdAt }`
 * with the three images as urls, and `users` how many readers use it (0
 * when the row did not come with a count).
 */
export function toDesign(row) {
  return {
    id: row.id,
    creatorId: row.creator_id,
    title: row.book_title,
    author: row.author ?? null,
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    front: artUrl(row.front_image_path),
    spine: artUrl(row.spine_image_path),
    back: artUrl(row.back_image_path),
    users: Number(row.users ?? 0),
    createdAt: row.created_at,
  };
}

/**
 * Shared covers matching every word of `query` in their title, author or
 * keywords -- or all of them, for an empty query -- most used first.
 */
export async function searchCovers(query = '') {
  const client = requireSupabase();
  const { data, error } = await client.rpc('search_cover_designs', {
    search: String(query).trim(),
    max_results: SEARCH_LIMIT,
  });
  if (error) throw failure(error);
  return (Array.isArray(data) ? data : []).map(toDesign);
}

/**
 * Read which covers the signed-in reader's books wear into
 * `community.attachments`. Signed out, that is none.
 */
export async function loadAttachments() {
  const userId = account.user?.id ?? null;
  if (!supabase || !userId) {
    community.attachments = {};
    community.error = '';
    return;
  }
  const { data, error } = await supabase
    .from('library')
    .select('epub_path, design:cover_designs(*)')
    .eq('user_id', userId)
    .not('design_id', 'is', null);
  // Signed out, or in as someone else, while this was on its way.
  if ((account.user?.id ?? null) !== userId) return;
  if (error) throw failure(error);

  const attachments = {};
  for (const row of data ?? []) {
    if (row.epub_path && row.design) attachments[row.epub_path] = toDesign(row.design);
  }
  community.attachments = attachments;
  community.error = '';
}

/** The reader's library row for a book, or null. */
async function libraryRow(userId, bookId) {
  const { data, error } = await supabase
    .from('library')
    .select('id')
    .eq('user_id', userId)
    .eq('epub_path', bookId)
    .limit(1);
  if (error) throw failure(error);
  return data?.[0] ?? null;
}

/**
 * Put a shared cover on one of your books.
 *
 * @param {{ id: string, title: string|null, author: string|null,
 *   size: { length: number, width: number, thickness: number } }} book
 *   one of community.books
 * @param {object} design  from searchCovers
 */
export async function attachCover(book, design) {
  const user = requireUser();
  const existing = await libraryRow(user.id, book.id);
  const { error } = existing
    ? await supabase.from('library').update({ design_id: design.id }).eq('id', existing.id)
    : await supabase.from('library').insert({
      user_id: user.id,
      epub_path: book.id,
      title: book.title ?? null,
      author: book.author ?? null,
      design_id: design.id,
      height_m: book.size?.length ?? 0,
      width_m: book.size?.width ?? 0,
      thickness_m: book.size?.thickness ?? 0,
      progress: 0,
    });
  if (error) throw failure(error);
  community.attachments = { ...community.attachments, [book.id]: design };
}

/** Take the shared cover off one of your books, back to its own. */
export async function detachCover(bookId) {
  const user = requireUser();
  const { error } = await supabase
    .from('library')
    .update({ design_id: null })
    .eq('user_id', user.id)
    .eq('epub_path', bookId);
  if (error) throw failure(error);
  const { [bookId]: _removed, ...rest } = community.attachments;
  community.attachments = rest;
}

/** "Sci-fi, space opera,  SPACE" -> ['sci-fi', 'space opera', 'space'], deduplicated. */
export function parseKeywords(text) {
  const words = String(text ?? '')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(words)].slice(0, MAX_KEYWORDS);
}

/**
 * Share a cover: upload its three images and list it.
 *
 * @param {{ title: string, author?: string, keywords?: string,
 *   front: File, spine: File, back: File }} cover  keywords comma-separated
 * @returns {Promise<object>} the new design, as searchCovers gives them
 */
export async function publishCover({ title, author = '', keywords = '', front, spine, back }) {
  const user = requireUser();
  const bookTitle = String(title ?? '').trim();
  if (!bookTitle) throw new Error('Give the cover the title of the book it is for.');

  const parts = { front, spine, back };
  for (const [part, file] of Object.entries(parts)) {
    if (!file) throw new Error(`Add a ${part} image.`);
    if (!EXTENSIONS[file.type]) throw new Error(`The ${part} image must be PNG, JPEG or WebP.`);
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`The ${part} image must be 5 MB or smaller.`);
  }

  // Named before anything is written, so the images can go into its folder.
  const id = crypto.randomUUID();
  const storage = supabase.storage.from(COVER_BUCKET);
  const uploaded = [];
  const paths = {};
  try {
    for (const [part, file] of Object.entries(parts)) {
      const path = `${user.id}/${id}/${part}.${EXTENSIONS[file.type]}`;
      // eslint-disable-next-line no-await-in-loop -- three files; one at a time keeps a failure tidy
      const { error } = await storage.upload(path, file, {
        contentType: file.type,
        cacheControl: '31536000', // a design's images never change under the same path
        upsert: false,
      });
      if (error) throw failure(error);
      uploaded.push(path);
      paths[part] = path;
    }

    const { data, error } = await supabase
      .from('cover_designs')
      .insert({
        id,
        creator_id: user.id,
        book_title: bookTitle,
        author: String(author ?? '').trim() || null,
        keywords: parseKeywords(keywords),
        front_image_path: paths.front,
        spine_image_path: paths.spine,
        back_image_path: paths.back,
      })
      .select()
      .single();
    if (error) throw failure(error);
    return toDesign({ ...data, users: 0 });
  } catch (err) {
    // A cover that did not make it into the listing leaves no images behind.
    if (uploaded.length) await storage.remove(uploaded).catch(() => {});
    throw err;
  }
}
