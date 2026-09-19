import * as pdfjsLib from 'pdfjs-dist';
// Vite-friendly way to point pdf.js at its worker bundle -- the `?url` import
// gives us a hashed, served URL for the worker file instead of trying to
// import it as a module. See https://vitejs.dev for the pattern.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { api } from './api.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

/**
 * bookLoader
 * ----------
 * Replaces the old foliate-js-based epub.js viewer. This module:
 *   1. Uploads a chosen .epub to the upload-server.ts backend
 *      (POST /api/books), which runs the Playwright epub->PDF conversion --
 *      OR, on startup, for quick local testing, checks whether a .pdf has
 *      just been dropped straight into src/books/ and loads that instead,
 *      no server/upload round-trip needed.
 *   2. Opens the resulting PDF with PDF.js and hands the book over the moment
 *      its page size and count are known -- a PageSource (openPdfPages),
 *      through `onPagesReady` -- then rasterizes the pages into it in the
 *      background, nearest the reader first, while the book is already in
 *      hand.
 *
 * Turning those canvases into page textures, and keeping them up to date as
 * they fill in, is book/reader/bookContent.js's job -- this module's stops at
 * "here are this book's pages, and here is each one as it is finished."
 *
 * NOTE: if the Vite dev server and the Express upload server run on
 * different ports, add a proxy for /api in vite.config.js, e.g.:
 *   server: { proxy: { '/api': 'http://localhost:3000' } }
 * Otherwise these fetches will 404 against the Vite dev server itself.
 */

const DEFAULT_RENDER_SCALE = 1.5; // px-per-pdf-unit; raise for sharper page textures

// --- folios (the printed page numbers) --------------------------------------
//
// Sized and positioned as FRACTIONS OF THE PAGE, never in pixels. A canvas's
// pixel size is page size x DEFAULT_RENDER_SCALE, so anything measured in
// pixels would silently change size the moment either one moved; expressed as
// a fraction, a folio is the same size relative to its page whatever the PDF's
// dimensions or the texture resolution, which is what makes it look identical
// from book to book once every page is mapped onto the same mesh.
//
// The stack matches the spine and jacket lettering in book/cover/jacketArt.js
// on purpose -- one typeface for everything the app itself prints, so the
// numbers read as part of the same edition rather than as an overlay.
const FOLIO_FONT = "Georgia, 'Times New Roman', serif";
const FOLIO_SIZE_FRACTION = 0.021; // of page width -- ~9.5pt on the 160mm page epubToPdf emits
const FOLIO_BASELINE_FRACTION = 0.024; // of page height, up from the bottom edge
const FOLIO_INK = 'rgba(0, 0, 0, 0.62)'; // lighter than body text, as a printed folio is

// Vite-only, build-time glob: resolves every .pdf under src/books/ to its
// served URL (no fetch/network round-trip -- Vite just hands back the
// asset URL string directly, same mechanism as the `?url` worker import
// above). This is a TESTING convenience: drop a PDF straight into
// src/books/ to skip the epub-upload/conversion pipeline entirely and
// exercise the page-texture/curl code against it immediately on reload.
// `eager: true` means this list is resolved once at module load, not
// lazily -- fine here since it's just filenames, not the PDF contents.
const LOCAL_BOOK_URLS = import.meta.glob('/src/books/*.pdf', {
  eager: true, import: 'default', query: '?url',
});

function findLocalBookUrl() {
  const paths = Object.keys(LOCAL_BOOK_URLS).sort();
  if (paths.length === 0) return null;
  return LOCAL_BOOK_URLS[paths[0]];
}

async function uploadEpub(file) {
  const formData = new FormData();
  formData.append('epub', file);
  const res = await fetch(api('/api/books'), { method: 'POST', body: formData });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Upload failed (${res.status})`);
  }
  if (!body.pdfUrl) {
    // Server responded 2xx but didn't send the shape we expect -- surface
    // the actual body instead of letting pdf.js fail later with a cryptic
    // "expected either data, range, or url parameter" error.
    console.error('Upload succeeded but response had no pdfUrl:', body);
    throw new Error('Upload response missing pdfUrl (see console for full response)');
  }
  return body; // { id, pdfUrl }
}

/**
 * Print a page number at the foot of a page that has just been rendered.
 *
 * Done here, onto the canvas, because there is nowhere later to do it: the
 * canvas becomes a THREE.CanvasTexture and from that point on a page is an
 * image on a curved mesh, with no text layer left to add to. Stamping at
 * render time also means the number curls, shades and turns with the paper
 * it is printed on, exactly like the rest of the page.
 *
 * WHY THE VIEWPORT DOES THE POSITIONING. The canvas is not the page the
 * right way up -- `rotation: 270` below turns it a quarter turn so it lands
 * on the mesh's UVs (see WHY 270 DEGREES at openPdfPages), which means
 * the foot of the PAGE is one of the canvas's SIDES, and which side depends
 * on the rotation. So the placement is worked out in PDF user space, where
 * "bottom centre" is unambiguous, and handed to the viewport to convert:
 *   - `viewBox` is the page's own rectangle in PDF units (y up from the
 *     bottom-left), so the target point is trivially expressed in it;
 *   - `convertToViewportPoint` maps that through whatever rotation, scale
 *     and flip the viewport is applying, landing on the right canvas pixel;
 *   - the transform's first column is where PDF's +x -- the direction text
 *     advances -- ended up, so its angle is the angle to rotate the context
 *     by for the number to sit the same way round as the words above it.
 * Nothing here hard-codes 270: change the rotation and the folio follows.
 */
function stampPageNumber(ctx, viewport, pageNumber) {
  const [left, bottom, right, top] = viewport.viewBox;
  const pageWidth = right - left;
  const pageHeight = top - bottom;

  const [x, y] = viewport.convertToViewportPoint(
    left + pageWidth / 2,
    bottom + pageHeight * FOLIO_BASELINE_FRACTION,
  );
  const angle = Math.atan2(viewport.transform[1], viewport.transform[0]);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  // scale converts PDF units to canvas pixels -- the same conversion the
  // viewport applied to everything page.render() just painted.
  ctx.font = `400 ${FOLIO_SIZE_FRACTION * pageWidth * viewport.scale}px ${FOLIO_FONT}`;
  ctx.fillStyle = FOLIO_INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic'; // sit the number ON the baseline, as type does
  ctx.fillText(String(pageNumber), 0, 0);
  ctx.restore();
}

// What an unrendered page looks like: blank paper, the same white a rendered
// page's own background is painted in, so a page filling in does not flash.
const BLANK_PAPER = '#ffffff';

/**
 * Open a PDF as a book's pages -- straight away, and render them afterwards.
 *
 * THE BOOK DOES NOT WAIT FOR ITS PAGES. All a book needs to be built is its
 * page size and its page count (onDimensions), and both are known once page 1
 * has been laid out -- long before a four-hundred-page book has been
 * rasterized. So that is when the book is handed over: every page exists at
 * once as a canvas of blank paper, and the pages are rendered INTO those same
 * canvases in the background, one at a time, each announcing itself when it
 * is done (onRendered) so whatever made a texture of it re-uploads it. You
 * can pick the book up, open it and turn through it while that happens; a
 * page not reached yet is blank paper until it is.
 *
 * NEAREST FIRST. The order is not front to back but outward from wherever the
 * reader is (focus()): the open spread, then the pages ahead of it, then
 * those behind -- so jumping to a chapter halfway through fills in there
 * next. The last page goes early too, since it is on show from the start as
 * the inside of the back cover.
 *
 * WHY 270 DEGREES. The page meshes' UVs put u along the spine (a page's
 * HEIGHT) and v from spine to fore-edge (its WIDTH), a quarter turn from a
 * PDF page the right way up -- and PageSimulation.root's permanent 180°
 * render flip adds a half turn on top. pdf.js's own `rotation: 270` does
 * both at once, sizing the viewport and its pixel transform together, which
 * is the fix for the unpainted band a hand-rolled context rotation left
 * along one edge of every page.
 *
 * @param {string} pdfUrl
 * @param {object} [opts]
 * @param {number} [opts.scale]  px per PDF unit
 * @param {(widthPts: number, heightPts: number, pageCount: number) => void|Promise<void>} [opts.onDimensions]
 *   the first page's unrotated size in PDF points, and the page count --
 *   awaited before anything else happens, since the caller rebuilds the
 *   book at that size
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<PageSource>}
 *
 * @typedef {object} PageSource
 * @property {number} count
 * @property {(index: number) => HTMLCanvasElement|null} canvasFor  a page's
 *   canvas, blank until it is rendered and the same object afterwards
 * @property {(index: number) => boolean} isRendered
 * @property {number} rendered  how many pages are drawn so far
 * @property {(index: number) => void} focus  where the reader is, 0-based
 * @property {(listener: (index: number, resized: boolean) => void) => () => void} onRendered
 *   `resized` when the page turned out a different size from the blank --
 *   an upload of the old size cannot take the new one
 * @property {() => void} cancel  stop rendering, for a book given up on
 */
async function openPdfPages(pdfUrl, { scale = DEFAULT_RENDER_SCALE, onDimensions, onProgress } = {}) {
  // Pass the config object explicitly rather than a bare string -- relying
  // on pdf.js to auto-wrap a string into { url } has proven flaky across
  // pdfjs-dist versions/bundlers, and throws exactly the
  // "expected either data, range, or url parameter" error when it doesn't.
  const loadingTask = pdfjsLib.getDocument({ url: pdfUrl });
  const pdf = await loadingTask.promise;
  const count = pdf.numPages;
  const first = await pdf.getPage(1);

  // Unscaled and UNrotated: the page's real reading-normal proportions, which
  // is what the book's geometry is sized from (see config.js). The page count
  // comes with it because the book's thickness is worked out from it, and
  // thickness, like page size, is baked in when the simulation is built.
  const raw = first.getViewport({ scale: 1 });
  if (onDimensions) await onDimensions(raw.width, raw.height, count);

  // The size of a blank page: page 1's, which is every page's in the PDFs the
  // converter writes. One that differs is resized when it is rendered.
  const blank = first.getViewport({ scale, rotation: 270 });

  const canvases = new Array(count).fill(null);
  const rendered = new Array(count).fill(false);
  const listeners = new Set();
  let done = 0;
  let focus = 0;
  let cancelled = false;

  function canvasFor(index) {
    if (index < 0 || index >= count) return null;
    if (!canvases[index]) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(blank.width);
      canvas.height = Math.floor(blank.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = BLANK_PAPER;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      canvases[index] = canvas;
    }
    return canvases[index];
  }

  // The next page to render: the unrendered one cheapest to be missing, by
  // how far it is from the reader -- ahead counts for less than behind, and
  // the last page (the inside of the back cover) costs as if a spread away.
  function next() {
    let best = -1;
    let bestCost = Infinity;
    for (let index = 0; index < count; index++) {
      if (rendered[index]) continue;
      const along = index - focus;
      const cost = index === count - 1 ? 3 : (along >= 0 ? along : -along * 2);
      if (cost < bestCost) {
        bestCost = cost;
        best = index;
      }
    }
    return best;
  }

  async function render(index) {
    const page = index === 0 ? first : await pdf.getPage(index + 1);
    if (cancelled) return;
    const viewport = page.getViewport({ scale, rotation: 270 });
    const canvas = canvasFor(index);
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);
    const resized = canvas.width !== width || canvas.height !== height;
    if (resized) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (cancelled) return;
    // After the render, not before: page.render() paints the page's own
    // background over anything already on the canvas.
    stampPageNumber(ctx, viewport, index + 1);
    page.cleanup();
    rendered[index] = true;
    done += 1;
    for (const listener of listeners) listener(index, resized);
    onProgress?.(done, count);
  }

  // In the background: the caller has its book as soon as this returns.
  (async () => {
    try {
      while (!cancelled && done < count) {
        const index = next();
        if (index < 0) break;
        await render(index);
      }
    } catch (err) {
      if (!cancelled) console.error('Rendering the book\'s pages failed:', err);
    } finally {
      // Every page is on its canvas now, or the book was given up on: either
      // way the document itself is no longer needed.
      loadingTask.destroy();
    }
  })();

  return {
    count,
    canvasFor,
    isRendered: (index) => Boolean(rendered[index]),
    /** How many pages are drawn so far. */
    get rendered() { return done; },
    focus(index) {
      focus = Math.max(0, Math.min(count - 1, Math.round(index)));
    },
    onRendered(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      listeners.clear();
      loadingTask.destroy();
    },
  };
}

/** Progress as a status line: the count while pages are rendering, then nothing. */
function progress(say) {
  return (done, total) => say(done < total ? `Rendering pages… ${done}/${total}` : '');
}

/**
 * The shelf's own record for a book, as GET /api/library lists it -- the shape
 * scene/inside/shelfBooks.js expects to be handed. Null if the server has no
 * such book, or no library at all.
 */
export async function libraryEntry(id) {
  try {
    const response = await fetch(api('/api/library'));
    if (!response.ok) return null;
    const books = await response.json();
    return (Array.isArray(books) ? books : []).find((book) => book.id === id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Open one of the shelf's books by its library id.
 *
 * The same pipeline an upload goes through, entered further along: the
 * server converts the epub (once -- see POST /api/library/:id/open) and the
 * pages are rasterized here exactly as they would be for an upload, so a
 * book reaches the scene by one path however it was chosen.
 *
 * @param {string} id  a library id, as listed by GET /api/library
 * @param {Object} [opts]  onDimensions and onPagesReady are as documented
 *   on initBookLoader, onJacket on uploadBook; onChapters receives the exact
 *   chapter pages; onStatus reports progress as text.
 */
export async function openLibraryBook(id, {
  onDimensions, onJacket, onChapters, onPagesReady, onStatus,
} = {}) {
  const say = (text) => onStatus?.(text);

  say('Converting…');
  const res = await fetch(api(`/api/library/${encodeURIComponent(id)}/open`), { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.pdfUrl) {
    throw new Error(body.error || `Could not open this book (${res.status})`);
  }

  // Before the pages, as with an upload: the jacket comes from the epub and
  // has been waiting since the shelf was built.
  onJacket?.({
    coverUrl: api(body.coverUrl) ?? null,
    title: body.title ?? null,
    author: body.author ?? null,
    description: body.description ?? null,
  });

  // Where the chapters really fall in this PDF, worked out when the book
  // was converted (server/epubToPdf.ts) rather than estimated from the
  // epub's text. The shelf's estimate has been standing in since pickup;
  // this replaces it. Absent for books converted before the numbering
  // existed, in which case the estimate simply stays.
  if (Array.isArray(body.chapters) && body.chapters.length > 0) onChapters?.(body.chapters);

  say('Opening…');
  const source = await openPdfPages(api(body.pdfUrl), { onDimensions, onProgress: progress(say) });
  onPagesReady?.(source);
  return source;
}

/**
 * Upload an EPUB from the reader's own computer, and open it.
 *
 * The same pipeline a shelf book goes through (openLibraryBook above),
 * entered at the very beginning: the server converts the file
 * (POST /api/books) and the pages are rasterized here. Unlike a shelf book
 * an upload is converted every time -- it has no library id to be cached
 * under.
 *
 * @param {File} file  an .epub
 * @param {Object} [opts]
 * @param {(jacket: { coverUrl: string|null, title: string|null,
 *   author: string|null, description: string|null }) => void} [opts.onJacket]
 *   Called once the book's jacket material is known, straight after
 *   conversion and before page rasterization.
 * @param {(chapters: { title: string, page: number }[]) => void} [opts.onChapters]
 *   The exact page each chapter starts on, as measured during conversion.
 * @param {(entry: object|null) => void} [opts.onShelved]  the shelf's record for
 *   the book that was just uploaded -- an upload joins the library (see
 *   POST /api/books), so it belongs on the shelf as well. Null if the listing
 *   could not be read back.
 * @param {Function} [opts.onDimensions]  see initBookLoader
 * @param {Function} [opts.onPagesReady]  see initBookLoader
 * @param {(text: string) => void} [opts.onStatus]  progress, as text
 */
export async function uploadBook(file, {
  onDimensions, onJacket, onChapters, onPagesReady, onStatus, onShelved,
} = {}) {
  const say = (text) => onStatus?.(text);

  say('Uploading and converting…');
  const book = await uploadEpub(file);

  // Before the pages, as for a shelf book: the jacket comes from the epub
  // and is ready the moment conversion is.
  onJacket?.({
    coverUrl: api(book.coverUrl) ?? null,
    title: book.title ?? null,
    author: book.author ?? null,
    description: book.description ?? null,
  });
  if (Array.isArray(book.chapters) && book.chapters.length > 0) onChapters?.(book.chapters);

  // The upload is one of the shelf's books now. Its record is read back from
  // the library rather than pieced together from the response, so what the
  // shelf is handed is exactly the shape the shelf lists.
  if (onShelved) onShelved(await libraryEntry(book.id));

  say('Opening…');
  const source = await openPdfPages(api(book.pdfUrl), { onDimensions, onProgress: progress(say) });
  onPagesReady?.(source);
  return source;
}

/**
 * The local-PDF testing shortcut. Call once from main.js.
 *
 * If a .pdf is already sitting in src/books/, render it immediately on
 * startup -- no upload, no server. Purely build-time (see LOCAL_BOOK_URLS
 * above), and a no-op when nothing is there. Opening a real EPUB is
 * uploadBook's job, reached from the Book tab, and openLibraryBook's for
 * the shelf.
 *
 * @param {Object} [opts]
 * @param {(pageWidthPts: number, pageHeightPts: number, pageCount: number) => void|Promise<void>} [opts.onDimensions]
 *   Called once, as soon as the first page's raw (unscaled) size and the
 *   document's page count are known -- before any canvas is rendered -- so
 *   the book's geometry can be sized to the PDF's actual page aspect ratio
 *   and its thickness to the page count. If it returns a promise,
 *   rendering waits for it before continuing (so a caller that disposes
 *   and recreates the whole page simulation here won't race with
 *   onPagesReady firing on the old one).
 * @param {(source: PageSource) => void} [opts.onPagesReady]
 *   Called with the book's pages as soon as onDimensions has finished --
 *   before they are rendered, which carries on in the background (see
 *   openPdfPages).
 * @param {(text: string) => void} [opts.onStatus]  progress, as text
 */
export function initBookLoader({ onDimensions, onPagesReady, onStatus } = {}) {
  const localUrl = findLocalBookUrl();
  if (!localUrl) return;

  const say = (text) => onStatus?.(text);
  say('Loading local test book…');
  openPdfPages(localUrl, { onDimensions, onProgress: progress(say) })
    .then((source) => onPagesReady?.(source))
    .catch((err) => {
      console.error('Failed to load local test book:', err);
      say(`Error: ${err.message}`);
    });
}