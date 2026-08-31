import * as pdfjsLib from 'pdfjs-dist';
// Vite-friendly way to point pdf.js at its worker bundle -- the `?url` import
// gives us a hashed, served URL for the worker file instead of trying to
// import it as a module. See https://vitejs.dev for the pattern.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

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
 *   2. Fetches the resulting PDF and rasterizes each page to a canvas via
 *      PDF.js.
 *   3. Hands the rendered page canvases back through `onPagesReady` so the
 *      caller can turn them into THREE.CanvasTexture page textures.
 *
 * Mapping those canvases onto the curl/flat page meshes (index-based UVs,
 * a sliding window of which pages are rasterized, mipmapping/anisotropy)
 * is the next piece of work and is intentionally NOT done here -- this
 * module's job stops at "here are rendered page canvases for this book."
 *
 * NOTE: if the Vite dev server and the Express upload server run on
 * different ports, add a proxy for /api in vite.config.js, e.g.:
 *   server: { proxy: { '/api': 'http://localhost:3000' } }
 * Otherwise these fetches will 404 against the Vite dev server itself.
 */

const DEFAULT_RENDER_SCALE = 1.5; // px-per-pdf-unit; raise for sharper page textures

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
  const res = await fetch('/api/books', { method: 'POST', body: formData });
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

async function renderPdfToCanvases(pdfUrl, { scale = DEFAULT_RENDER_SCALE, onPage, onDimensions } = {}) {
  // Pass the config object explicitly rather than a bare string -- relying
  // on pdf.js to auto-wrap a string into { url } has proven flaky across
  // pdfjs-dist versions/bundlers, and throws exactly the
  // "expected either data, range, or url parameter" error when it doesn't.
  const loadingTask = pdfjsLib.getDocument({ url: pdfUrl });
  const pdf = await loadingTask.promise;
  const canvases = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);

    // The page meshes' UVs (the flat pages' default PlaneGeometry UVs, and
    // CURL_UV in curlGeometry.js) both put u along HINGE_LEN -- the X axis,
    // which is physically the page's HEIGHT, since it runs the length of
    // the spine -- and v along PANEL_REACH -- physically the page's WIDTH,
    // spine to outer edge. A PDF page renders reading-normal: an unrotated
    // viewport's width is its (short) reading-horizontal axis, its height
    // the (long) top-to-bottom axis -- a 90° mismatch against the mesh UVs
    // (the short axis would land on the mesh's long axis and vice versa,
    // which is what showed up as text running horizontally instead of
    // vertically). `rotation: 270` (270° clockwise, == 90° counter-
    // clockwise) bakes in both that axis swap AND the extra 180° needed to
    // counter PageSimulation.root's permanent 180° render flip (see the
    // PageSimulation constructor) -- same net rotation the old hand-rolled
    // ctx.translate()+ctx.rotate(-Math.PI/2) pre-transform was going for.
    //
    // Doing it via pdf.js's OWN rotation support instead of that manual
    // context transform is the actual fix here, not just a rewrite: the
    // pre-transform left an unpainted band along one edge of every
    // canvas -- confirmed by rendering a raw page canvas directly, with no
    // 3D mesh involved at all -- almost certainly because page.render()'s
    // own internal bounds/clipping math doesn't expect the context handed
    // to it to already carry a rotation. Letting pdf.js compute the
    // rotated viewport itself (swapped width/height AND the matching pixel
    // transform, both baked in together) means page.render() always paints
    // into a plain, un-pre-transformed context sized to exactly match --
    // nothing left for a transform-composition edge case to leave blank.
    const viewport = page.getViewport({ scale, rotation: 270 });

    if (pageNum === 1 && onDimensions) {
      // Unscaled, UN-rotated page size, in PDF points -- the actual page
      // aspect ratio, independent of DEFAULT_RENDER_SCALE. Rotation only
      // ever swaps width/height at some multiple of 90°, it never changes
      // the page's own real proportions, so this must stay unrotated
      // (rotation defaults to 0) for onDimensions's meaning -- the PDF's
      // real reading-normal aspect ratio -- to stay correct. Reported once,
      // from the first page, before rendering proceeds any further, so the
      // caller can resize the book's geometry (HINGE_LEN/PANEL_REACH, see
      // config.js) to match before any page mesh or physics body gets
      // built from the old default dimensions. Awaited: if the caller's
      // handler resizes/recreates the whole simulation, rendering the rest
      // of the pages (and firing onPage/the eventual onPagesReady) needs to
      // wait for that to actually finish first.
      const rawViewport = page.getViewport({ scale: 1 });
      await onDimensions(rawViewport.width, rawViewport.height);
    }

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    canvases.push(canvas);
    onPage?.(canvases.length, pdf.numPages);
  }
  return canvases;
}

/**
 * Wires up the #epub-file input and #upload-status element already present
 * in index.html. Call once from main.js.
 *
 * @param {Object} [opts]
 * @param {(pageWidthPts: number, pageHeightPts: number) => void|Promise<void>} [opts.onDimensions]
 *   Called once, as soon as the first page's raw (unscaled) size is known
 *   -- before any canvas is rendered -- so the book's geometry can be
 *   sized to the PDF's actual page aspect ratio. If it returns a promise,
 *   rendering waits for it before continuing (so a caller that disposes
 *   and recreates the whole page simulation here won't race with
 *   onPagesReady firing on the old one).
 * @param {(canvases: HTMLCanvasElement[]) => void} [opts.onPagesReady]
 *   Called once all pages of a successfully-converted book have been
 *   rendered to canvas. Wire this up to build page textures once that
 *   part of the pipeline exists.
 */
export function initBookLoader({ onDimensions, onPagesReady } = {}) {
  const input = document.getElementById('epub-file');
  const status = document.getElementById('upload-status');

  const setStatus = (text) => { if (status) status.textContent = text; };

  async function loadAndRenderPdf(pdfUrl) {
    setStatus('Rendering pages…');
    const canvases = await renderPdfToCanvases(pdfUrl, {
      onDimensions,
      onPage: (done, total) => setStatus(`Rendering pages… ${done}/${total}`),
    });
    setStatus(`Ready: ${canvases.length} page(s) rendered.`);
    onPagesReady?.(canvases);
  }

  input?.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;

    input.disabled = true;
    try {
      setStatus('Uploading and converting…');
      const { pdfUrl } = await uploadEpub(file);
      await loadAndRenderPdf(pdfUrl);
    } catch (err) {
      console.error('Book upload/conversion failed:', err);
      setStatus(`Error: ${err.message}`);
    } finally {
      input.disabled = false;
    }
  });

  // Testing shortcut: if a .pdf is already sitting in src/books/, render it
  // immediately on startup -- no upload needed. Purely local/build-time
  // (see LOCAL_BOOK_URLS above), so this doesn't touch the upload server at
  // all. If nothing's there, this is a no-op and the upload panel just sits
  // in its normal idle state.
  const localUrl = findLocalBookUrl();
  if (localUrl) {
    if (input) input.disabled = true;
    setStatus('Loading local test book…');
    loadAndRenderPdf(localUrl)
      .catch((err) => {
        console.error('Failed to load local test book:', err);
        setStatus(`Error: ${err.message}`);
      })
      .finally(() => {
        if (input) input.disabled = false;
      });
  }
}