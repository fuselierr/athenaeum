// epub-to-pdf.ts
//
// Converts an epub into a single, paginated PDF by handing its chapters to a
// real browser (Chromium, via Playwright) and letting the browser's own print
// pipeline do the pagination -- so we never have to reimplement CSS-columns
// pagination ourselves. Usage:
//
//   node epub-to-pdf.ts <input.epub> <output.pdf>
//
// The resulting PDF is what a client-side PDF.js texture pipeline reads from
// later; this script's only job is producing that PDF.

import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { chromium } from 'playwright';

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
}

interface PdfPageOptions {
  width?: string;
  height?: string;
  margin?: { top: string; bottom: string; left: string; right: string };
  // Only needed if you're pointing at a specific pre-installed Chromium
  // (e.g. a custom Docker image) instead of the one `playwright install`
  // downloads normally.
  executablePath?: string;
}

async function loadEpub(epubPath: string): Promise<JSZip> {
  const data = await readFile(epubPath);
  return JSZip.loadAsync(data);
}

// META-INF/container.xml is the one fixed, well-known path every epub has --
// it just points at the real package (.opf) file, whose own path is not
// standardized (varies book to book).
async function findOpfPath(zip: JSZip): Promise<string> {
  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  if (!containerXml) throw new Error('META-INF/container.xml not found -- not a valid epub');

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(containerXml);
  const rootfileRaw = parsed.container.rootfiles.rootfile;
  const rootfiles = Array.isArray(rootfileRaw) ? rootfileRaw : [rootfileRaw];
  const opf = rootfiles.find((r: any) => r['@_media-type'] === 'application/oebps-package+xml') ?? rootfiles[0];
  return opf['@_full-path'];
}

// The OPF's <manifest> lists every file in the book (id -> href); its <spine>
// lists which of those, and in what order, are actually meant to be read --
// a manifest item can exist (e.g. a cover image, a font) without being part
// of the spine at all.
async function parseSpine(zip: JSZip, opfPath: string) {
  const opfXml = await zip.file(opfPath)?.async('string');
  if (!opfXml) throw new Error(`OPF file not found at ${opfPath}`);
  const opfDir = path.posix.dirname(opfPath);

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const pkg = parser.parse(opfXml).package;

  const manifestRaw = pkg.manifest.item;
  const manifestList: any[] = Array.isArray(manifestRaw) ? manifestRaw : [manifestRaw];
  const manifest = new Map<string, ManifestItem>();
  for (const item of manifestList) {
    manifest.set(item['@_id'], { id: item['@_id'], href: item['@_href'], mediaType: item['@_media-type'] });
  }

  const spineRaw = pkg.spine.itemref;
  const spineList: any[] = Array.isArray(spineRaw) ? spineRaw : [spineRaw];
  const spineHrefs = spineList
    .filter((s) => s['@_linear'] !== 'no') // "linear=no" spine items are supplementary, not part of the main reading order
    .map((s) => {
      const item = manifest.get(s['@_idref']);
      if (!item) throw new Error(`Spine references unknown manifest id: ${s['@_idref']}`);
      return path.posix.join(opfDir, item.href);
    });

  return { opfDir, spineHrefs };
}

// Chapters are individual <html><body>...</body></html> documents; pulling
// just the body content out is what lets us stitch many chapters into one
// combined document with a single <head>/stylesheet instead of nested <html>s.
function extractBody(xhtml: string): string {
  const match = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return match ? match[1] : xhtml;
}

async function buildCombinedHtml(zip: JSZip, opfPath: string, workDir: string): Promise<string> {
  const { opfDir, spineHrefs } = await parseSpine(zip, opfPath);

  // Extract every file in the epub into workDir, preserving its internal
  // folder layout. This is what lets the combined HTML's relative <img src>
  // and <link href> paths resolve correctly once Chromium loads it as a
  // file:// URL, with no need to rewrite each reference by hand.
  for (const filePath of Object.keys(zip.files)) {
    const entry = zip.files[filePath];
    if (entry.dir) continue;
    const destPath = path.join(workDir, filePath);
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, await entry.async('nodebuffer'));
  }

  const bodyChunks: string[] = [];
  for (const href of spineHrefs) {
    const xhtml = await zip.file(href)?.async('string');
    if (!xhtml) continue;
    // break-before: page forces each chapter to start on its own PDF page --
    // Chromium's print pipeline honors standard CSS break properties.
    bodyChunks.push(`<section style="break-before: page;">${extractBody(xhtml)}</section>`);
  }
  if (bodyChunks.length === 0) throw new Error('No spine chapters produced any content');

  // Reuses whichever stylesheet(s) the first chapter links to. Extend this
  // (e.g. union of all chapters' <link> tags) if a book uses per-chapter
  // stylesheets rather than one shared one -- the common case is one shared
  // stylesheet for the whole book.
  const firstChapterHtml = await zip.file(spineHrefs[0])?.async('string');
  const stylesheetLinks = [...(firstChapterHtml?.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi) ?? [])]
    .map((m) => m[0])
    .join('\n');

  const combinedHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${stylesheetLinks}
</head>
<body>
${bodyChunks.join('\n')}
</body>
</html>`;

  // Written alongside the extracted chapters (inside opfDir) so the
  // stylesheet/image relative paths above resolve exactly the way they did
  // for the original chapter files.
  const outputPath = path.join(workDir, opfDir, '__combined__.html');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, combinedHtml, 'utf-8');
  return outputPath;
}

export async function epubToPdf(epubPath: string, outputPdfPath: string, options: PdfPageOptions = {}): Promise<void> {
  const zip = await loadEpub(epubPath);
  const opfPath = await findOpfPath(zip);
  const workDir = await mkdtemp(path.join(tmpdir(), 'epub-'));

  const combinedHtmlPath = await buildCombinedHtml(zip, opfPath, workDir);

  const browser = await chromium.launch(
    options.executablePath ? { executablePath: options.executablePath } : {},
  );
  try {
    const page = await browser.newPage();
    await page.goto(`file://${combinedHtmlPath}`, { waitUntil: 'networkidle' });
    await page.pdf({
      path: outputPdfPath,
      // Match these to your 3D page mesh's aspect ratio (PANEL_REACH/HINGE_LEN).
      width: options.width ?? '160mm',
      height: options.height ?? '220mm',
      printBackground: true, // without this, CSS background colors/images are silently dropped
      margin: options.margin ?? { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await browser.close();
  }
}

// CLI entry point: `node epub-to-pdf.ts input.epub output.pdf`
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [, , epubPath, outputPdfPath] = process.argv;
  if (!epubPath || !outputPdfPath) {
    console.error('Usage: node epub-to-pdf.ts <input.epub> <output.pdf>');
    process.exit(1);
  }
  epubToPdf(epubPath, outputPdfPath)
    .then(() => console.log(`Wrote ${outputPdfPath}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}