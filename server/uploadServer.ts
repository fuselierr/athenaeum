// upload-server.ts
//
// A small Express server exposing:
//   POST /api/books          -- upload an .epub, get back { id, pdfUrl, ...meta }
//   GET  /api/books/:id/pdf   -- fetch the converted PDF (what your client-side
//                                PDF.js/three.js pipeline reads from)
//   GET  /api/books/:id/cover -- the epub's own cover image, if it had one
//   GET  /api/books/:id/meta  -- { title, author, description, coverUrl }
//   GET  /api/library         -- the raw epubs in src/books, for the shelf
//   GET  /api/library/:id/cover -- one of those epubs' cover images
//   POST /api/library/:id/open  -- convert one of them (once) and get
//                                 back the same shape POST /api/books does
//
// Usage: node server/uploadServer.ts

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { epubToPdf, type PdfChapter } from './epubToPdf.ts';
import { extractEpubMetadata } from './epubMetadata.ts';
import { readLibrary } from './epubLibrary.ts';

const STORAGE_DIR = path.join(process.cwd(), 'books');
// The shelf's library: raw epubs, never converted. Separate from
// STORAGE_DIR, which holds books the reader has actually opened.
// Bumped whenever a change here alters what a converted PDF LOOKS like --
// the contents page, the chapter headings, the page numbering. A book
// converted under an older number is converted again the next time it is
// opened, so a cache that exists to make the second visit free does not
// also freeze every book in the shape it had the first time.
const CONVERSION_VERSION = 2;

const LIBRARY_DIR = path.join(process.cwd(), 'src', 'books');
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB -- generous for an epub, adjust to taste

const app = express();

// Disk storage, not memory storage: epubs (and the images inside them) can
// be tens of MB, and multer's default memory storage would hold the whole
// file in RAM per concurrent upload -- fine for a demo, worth revisiting
// before this ever sees real traffic.
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await mkdir(STORAGE_DIR, { recursive: true });
      cb(null, STORAGE_DIR);
    },
    filename: (_req, file, cb) => {
      // Temp name for the raw upload -- renamed into its own id folder once
      // we know the book's id, see the handler below.
      cb(null, `upload-${randomUUID()}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const isEpub = file.mimetype === 'application/epub+zip' || file.originalname.toLowerCase().endsWith('.epub');
    // Browsers are inconsistent about what mimetype they report for .epub
    // (some send application/octet-stream), so the extension check matters
    // as much as the mimetype -- this is a shallow check, not a security
    // boundary; epubToPdf itself will throw on a file that isn't actually a
    // valid epub, which the handler below turns into a 422.
    cb(null, isEpub);
  },
});

app.post('/api/books', upload.single('epub'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Missing epub file (expected multipart field name "epub")' });
    return;
  }

  const id = randomUUID();
  const bookDir = path.join(STORAGE_DIR, id);
  const pdfPath = path.join(bookDir, 'book.pdf');

  try {
    await mkdir(bookDir, { recursive: true });
    const converted = await epubToPdf(req.file.path, pdfPath);

    // Jacket material, pulled straight from the epub rather than from the
    // rendered PDF: the cover is usually absent from the reading order
    // epubToPdf walks, so the PDF's first page is not reliably the cover.
    // Non-fatal -- a book with no cover image still converts fine, it just
    // gets a plain board in the viewer.
    let meta: BookMeta = {
      title: null, author: null, description: null, coverUrl: null,
      chapters: converted.chapters,
    };
    try {
      const extracted = await extractEpubMetadata(req.file.path);
      if (extracted.cover) {
        await writeFile(path.join(bookDir, `cover${extracted.cover.extension}`), extracted.cover.data);
        await writeFile(path.join(bookDir, 'cover.type'), extracted.cover.mediaType, 'utf-8');
        meta.coverUrl = `/api/books/${id}/cover`;
      }
      meta.title = extracted.title;
      meta.author = extracted.author;
      meta.description = extracted.description;
    } catch (metaErr) {
      console.error(`Cover/metadata extraction failed for ${req.file.originalname} (continuing):`, metaErr);
    }
    await writeFile(
      path.join(bookDir, 'meta.json'),
      JSON.stringify({ ...meta, conversion: CONVERSION_VERSION }),
      'utf-8',
    );

    res.status(201).json({ id, pdfUrl: `/api/books/${id}/pdf`, ...meta });
  } catch (err) {
    // Most likely cause: the uploaded file passed the extension check above
    // but isn't actually a well-formed epub (missing container.xml, broken
    // spine, etc.) -- epubToPdf's own error messages say which.
    console.error(`Conversion failed for upload ${req.file.originalname}:`, err);
    await rm(bookDir, { recursive: true, force: true });
    res.status(422).json({ error: 'Could not convert this file -- is it a valid epub?' });
  } finally {
    // The raw upload is only scratch material once conversion has run (or
    // failed) -- the PDF (or nothing, on failure) is what's kept.
    await rm(req.file.path, { force: true });
  }
});

interface BookMeta {
  title: string | null;
  author: string | null;
  description: string | null;
  coverUrl: string | null;
  /**
   * [{ title, page }] -- where the chapters actually fall in THIS PDF,
   * measured during conversion rather than estimated from the epub's text.
   * The shelf listing carries an estimate (see server/epubToc.ts) so the
   * Book tab has something the moment a book is picked up; these replace
   * it as soon as the book opens, and are exact.
   */
  chapters: PdfChapter[];
}

/**
 * The shelf's library. Cover bytes are stripped -- they go out through the
 * cover route below rather than as base64 in a listing.
 */
app.get('/api/library', async (_req, res) => {
  try {
    const books = await readLibrary(LIBRARY_DIR);
    res.json(books.map(({
      id, title, author, description, cover, characters, pages, chapters,
    }) => ({
      id,
      title,
      author,
      description,
      coverUrl: cover ? `/api/library/${id}/cover` : null,
      characters,
      pages,
      chapters,
    })));
  } catch {
    res.status(500).json({ error: 'Could not read the library' });
  }
});

app.get('/api/library/:id/cover', async (req, res) => {
  const book = (await readLibrary(LIBRARY_DIR)).find((b) => b.id === req.params.id);
  if (!book?.cover) {
    res.status(404).json({ error: 'This book has no cover image' });
    return;
  }
  res.type(book.cover.mediaType).send(book.cover.data);
});

interface OpenedBook extends BookMeta {
  id: string;
  pdfUrl: string;
}

/**
 * Convert one of the shelf's epubs, or hand back the conversion from last
 * time.
 *
 * The output is stored under the LIBRARY SLUG rather than a fresh uuid,
 * which is the whole point: a shelf book is the same book every time it is
 * picked up, so the second visit costs nothing and the reader opens it
 * immediately. Layout matches what POST /api/books writes, so the existing
 * pdf / cover / meta routes serve these without knowing the difference.
 */
async function openLibraryBook(id: string): Promise<OpenedBook | null> {
  const book = (await readLibrary(LIBRARY_DIR)).find((b) => b.id === id);
  if (!book) return null;

  const bookDir = path.join(STORAGE_DIR, id);
  const pdfPath = path.join(bookDir, 'book.pdf');
  const meta: OpenedBook = {
    id,
    pdfUrl: `/api/books/${id}/pdf`,
    title: book.title,
    author: book.author,
    description: book.description,
    coverUrl: book.cover ? `/api/books/${id}/cover` : null,
    chapters: [],
  };

  try {
    await access(pdfPath);
    // Converted on an earlier visit -- so the exact chapter pages were
    // worked out then and written down, and re-reading them is the whole
    // reason a second visit is free.
    const stored = JSON.parse(await readFile(path.join(bookDir, 'meta.json'), 'utf-8'));
    if (stored?.conversion === CONVERSION_VERSION) {
      if (Array.isArray(stored.chapters)) meta.chapters = stored.chapters;
      return meta;
    }
  } catch {
    // Not converted yet, or nothing readable written down; do the work.
  }

  await mkdir(bookDir, { recursive: true });
  try {
    const converted = await epubToPdf(book.file, pdfPath);
    meta.chapters = converted.chapters;
    // The cover was already read out of the epub by readLibrary, so it is
    // written straight through rather than extracted a second time.
    if (book.cover) {
      await writeFile(path.join(bookDir, `cover${book.cover.extension}`), book.cover.data);
      await writeFile(path.join(bookDir, 'cover.type'), book.cover.mediaType, 'utf-8');
    }
    const { id: _id, pdfUrl: _pdfUrl, ...stored } = meta;
    await writeFile(
      path.join(bookDir, 'meta.json'),
      JSON.stringify({ ...stored, conversion: CONVERSION_VERSION }),
      'utf-8',
    );
  } catch (err) {
    // A half-written folder would look converted to the check above and
    // fail forever after, so failure leaves nothing behind.
    await rm(bookDir, { recursive: true, force: true });
    throw err;
  }
  return meta;
}

// Conversions in flight, by id. The shelf stays clickable while a book is
// converting, and a second click on the same spine must join the first
// rather than race it to the same file.
const opening = new Map<string, Promise<OpenedBook | null>>();

app.post('/api/library/:id/open', async (req, res) => {
  const { id } = req.params;
  let pending = opening.get(id);
  if (!pending) {
    pending = openLibraryBook(id);
    opening.set(id, pending);
    pending
      .catch(() => {}) // handled below; this is only to unregister
      .finally(() => { if (opening.get(id) === pending) opening.delete(id); });
  }

  try {
    const book = await pending;
    if (!book) {
      res.status(404).json({ error: 'No such book on the shelf' });
      return;
    }
    res.json(book);
  } catch (err) {
    console.error(`Conversion failed for library book ${id}:`, err);
    res.status(422).json({ error: 'Could not convert this book' });
  }
});

app.get('/api/books/:id/pdf', (req, res) => {
  const pdfPath = path.join(STORAGE_DIR, req.params.id, 'book.pdf');
  res.sendFile(pdfPath, (err) => {
    if (err) res.status(404).json({ error: 'No such book' });
  });
});

app.get('/api/books/:id/meta', async (req, res) => {
  try {
    const raw = await readFile(path.join(STORAGE_DIR, req.params.id, 'meta.json'), 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: 'No such book' });
  }
});

// The extension varies with whatever the epub carried, so the stored
// media type is read back rather than guessed from the filename.
app.get('/api/books/:id/cover', async (req, res) => {
  const bookDir = path.join(STORAGE_DIR, req.params.id);
  let mediaType: string;
  try {
    mediaType = (await readFile(path.join(bookDir, 'cover.type'), 'utf-8')).trim();
  } catch {
    res.status(404).json({ error: 'This book has no cover image' });
    return;
  }
  const ext = EXT_BY_MEDIA_TYPE[mediaType] ?? '.img';
  res.type(mediaType).sendFile(path.join(bookDir, `cover${ext}`), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'This book has no cover image' });
  });
});

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg',
};

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log(`epub upload server listening on :${PORT}`));