// upload-server.ts
//
// A small Express server exposing:
//   POST /api/books          -- upload an .epub, get back { id, pdfUrl, ...meta }
//   GET  /api/books/:id/pdf   -- fetch the converted PDF (what your client-side
//                                PDF.js/three.js pipeline reads from)
//   GET  /api/books/:id/cover -- the epub's own cover image, if it had one
//   GET  /api/books/:id/meta  -- { title, author, description, coverUrl }
//
// Usage: node server/uploadServer.ts

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { epubToPdf } from './epubToPdf.ts';
import { extractEpubMetadata } from './epubMetadata.ts';

const STORAGE_DIR = path.join(process.cwd(), 'books');
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
    await epubToPdf(req.file.path, pdfPath);

    // Jacket material, pulled straight from the epub rather than from the
    // rendered PDF: the cover is usually absent from the reading order
    // epubToPdf walks, so the PDF's first page is not reliably the cover.
    // Non-fatal -- a book with no cover image still converts fine, it just
    // gets a plain board in the viewer.
    let meta: BookMeta = { title: null, author: null, description: null, coverUrl: null };
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
    await writeFile(path.join(bookDir, 'meta.json'), JSON.stringify(meta), 'utf-8');

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
}

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