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
 *      (POST /api/books), which runs the Playwright epub->PDF conversion.
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

async function renderPdfToCanvases(pdfUrl, { scale = DEFAULT_RENDER_SCALE, onPage } = {}) {
  // Pass the config object explicitly rather than a bare string -- relying
  // on pdf.js to auto-wrap a string into { url } has proven flaky across
  // pdfjs-dist versions/bundlers, and throws exactly the
  // "expected either data, range, or url parameter" error when it doesn't.
  const loadingTask = pdfjsLib.getDocument({ url: pdfUrl });
  const pdf = await loadingTask.promise;
  const canvases = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
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
 * @param {(canvases: HTMLCanvasElement[]) => void} [opts.onPagesReady]
 *   Called once all pages of a successfully-converted book have been
 *   rendered to canvas. Wire this up to build page textures once that
 *   part of the pipeline exists.
 */
export function initBookLoader({ onPagesReady } = {}) {
  const input = document.getElementById('epub-file');
  const status = document.getElementById('upload-status');

  const setStatus = (text) => { if (status) status.textContent = text; };

  input?.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;

    input.disabled = true;
    try {
      setStatus('Uploading and converting…');
      const { pdfUrl } = await uploadEpub(file);

      setStatus('Rendering pages…');
      const canvases = await renderPdfToCanvases(pdfUrl, {
        onPage: (done, total) => setStatus(`Rendering pages… ${done}/${total}`),
      });

      setStatus(`Ready: ${canvases.length} page(s) rendered.`);
      onPagesReady?.(canvases);
    } catch (err) {
      console.error('Book upload/conversion failed:', err);
      setStatus(`Error: ${err.message}`);
    } finally {
      input.disabled = false;
    }
  });
}