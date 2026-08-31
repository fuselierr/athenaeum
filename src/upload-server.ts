// upload-server.ts
//
// A small Express server exposing:
//   POST /api/books        -- upload an .epub, get back { id, pdfUrl }
//   GET  /api/books/:id/pdf -- fetch the converted PDF (what your client-side
//                              PDF.js/three.js pipeline reads from)
//
// Usage: node upload-server.ts

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { epubToPdf } from './epub-to-pdf.ts';

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
    res.status(201).json({ id, pdfUrl: `/api/books/${id}/pdf` });
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

app.get('/api/books/:id/pdf', (req, res) => {
  const pdfPath = path.join(STORAGE_DIR, req.params.id, 'book.pdf');
  res.sendFile(pdfPath, (err) => {
    if (err) res.status(404).json({ error: 'No such book' });
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log(`epub upload server listening on :${PORT}`));