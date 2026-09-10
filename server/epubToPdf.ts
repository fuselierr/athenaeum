// epubToPdf.ts
//
// Converts an epub into a single, paginated PDF by handing its chapters to a
// real browser (Chromium, via Playwright) and letting the browser's own print
// pipeline do the pagination -- so we never have to reimplement CSS-columns
// pagination ourselves. Usage:
//
//   node epubToPdf.ts <input.epub> <output.pdf>
//
// The resulting PDF is what a client-side PDF.js texture pipeline reads from
// later; this script's only job is producing that PDF.

import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { chromium } from 'playwright';
import { readTocEntries } from './epubToc.ts';

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

/** A chapter, and the PDF page it turned out to start on. */
export interface PdfChapter {
  title: string;
  page: number; // 1-based, and exact -- see the two-pass note on epubToPdf
}

export interface EpubPdfResult {
  pageCount: number;
  chapters: PdfChapter[];
}

/** One TOC entry, resolved to a place in the combined document. */
interface ChapterPlan {
  title: string;
  sectionIndex: number; // which spine section, by position
  fragment: string; // the anchor within it, or '' for its start
  token: string; // the marker printed there, to find the page again
}

// A book with hundreds of TOC entries is usually one with an entry per
// paragraph; past this the contents stops being a contents.
const MAX_CONTENTS_ENTRIES = 250;

// One entry is a list, not a contents page. Below this the page is
// skipped -- though the chapters behind it are still numbered, since the
// reader navigates by those whether the page exists or not.
const CONTENTS_MIN_ENTRIES = 2;

// Longest run of text that can plausibly BE a chapter title. What the TOC
// points at is often just a paragraph in the middle of the prose, and
// setting that in 1.4em small caps would be worse than leaving it alone.
const HEADING_MAX_CHARS = 90;

const markerToken = (index: number) => `ATHMARK${String(index).padStart(4, '0')}ZZ`;

const escapeHtml = (text: string) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Comparable form of an epub-internal path, matching epubToc's. */
const zipKey = (href: string) => path.posix.normalize(decodeURIComponent(href));

/**
 * What a book looks like when its own stylesheet says nothing.
 *
 * Goes BEFORE the epub's own <link>s, so the book wins on anything it has
 * an opinion about -- this is a floor, not a house style.
 */
const BASE_CSS = `
  body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.55; }
  img { max-width: 100%; height: auto; }
`;

/**
 * Goes AFTER the epub's stylesheets, and therefore wins. Everything here
 * is either something the book cannot know about (our contents page) or
 * something it got wrong for print.
 */
const ATHENAEUM_CSS = `
  /* A printed page has no links to click. In most of these books the
     chapter openings and the built-in contents ARE anchors, which is
     exactly what was arriving as blue underlined text that did nothing. */
  a, a:link, a:visited { color: inherit; text-decoration: none; }

  /* Chapter openings. .ath-heading is applied in the browser, to whatever
     the table of contents actually points at (see MARK_CHAPTERS), because
     a great many epubs -- anything calibre or pdftohtml produced -- carry
     no <h*> elements at all: the chapter title is a <p> like every other
     <p>, and the only thing that identifies it is that the TOC links to
     it. font-family is inherited on purpose. The heading should be the
     book's own typeface a size up, not a face of ours imposed on it. */
  h1, h2, h3, h4, h5, h6, .ath-heading {
    font-family: inherit;
    font-weight: 600;
    font-size: 1.4em;
    line-height: 1.3;
    letter-spacing: 0.06em;
    font-variant-caps: small-caps;
    text-align: center;
    text-indent: 0;
    margin: 0 0 1.8em;
    /* A heading stranded at the foot of a page is the one thing that
       always reads as a mistake; this takes it over with its text. */
    break-after: avoid;
    page-break-after: avoid;
    break-inside: avoid;
  }
  /* Chapter titles are commonly wrapped in <b> or <i> by the converter
     that made the epub; the heading sets the weight now, not they. */
  h1 > *, h2 > *, h3 > *, h4 > *, h5 > *, h6 > *, .ath-heading > * {
    font-weight: inherit;
    font-size: inherit;
    font-style: normal;
    letter-spacing: inherit;
  }

  /* The sink: a chapter opens a little way down its page rather than hard
     against the top margin, the way a printed book does. Padding on the
     section applies at its start only, so it costs nothing on the pages
     the chapter continues onto. */
  .ath-chapter { break-before: page; padding-top: 2.4em; }

  .ath-contents { padding-top: 1em; }
  .ath-contents-list { list-style: none; margin: 0; padding: 0; }
  .ath-entry {
    display: flex;
    align-items: baseline;
    gap: 0.45em;
    text-align: left;
    text-indent: 0;
    /* Fixed line box, no wrapping: every entry is exactly one line tall
       whatever it says. That is what lets the second pass write the page
       numbers in without repaginating the book underneath them. */
    line-height: 2.05;
    white-space: nowrap;
  }
  .ath-entry-title { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .ath-entry-leader {
    flex: 1 1 auto;
    border-bottom: 1px dotted currentColor;
    opacity: 0.4;
    transform: translateY(-0.28em);
  }
  .ath-entry-folio { flex: 0 0 2.8em; text-align: right; font-variant-numeric: tabular-nums; }
  /* An entry whose page could not be found keeps its place in the list
     and simply goes without a number. */
  .ath-entry[data-ath-found="no"] .ath-entry-leader,
  .ath-entry[data-ath-found="no"] .ath-entry-folio { visibility: hidden; }

  /* Position markers. These have to be REAL text -- pdf.js finds them by
     extracting each page's text -- while being invisible and taking up no
     room, and they are present in BOTH passes so the two paginate
     identically. */
  .ath-mark { font-size: 1px; line-height: 0; letter-spacing: 0; color: #fff; }
`;

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

/**
 * Runs IN THE PAGE. Puts a position marker at every chapter opening, and
 * makes the ones that look like titles look like titles.
 *
 * Done in the browser rather than by rewriting the XHTML on the way in
 * because the question -- "is the thing this TOC entry points at a chapter
 * heading, or is it the middle of a paragraph?" -- is a question about the
 * rendered document, and the DOM answers it exactly where a regex over
 * markup would be guessing. Everything it needs arrives in `plan`; it
 * closes over nothing, because Playwright ships it across as source.
 */
const MARK_CHAPTERS = ([plan, headingMaxChars]: [ChapterPlan[], number]) => {
  const sections = document.querySelectorAll('.ath-chapter');

  for (const chapter of plan) {
    const section = sections[chapter.sectionIndex];
    if (!section) continue;

    let anchor: Element | null = null;
    if (chapter.fragment) {
      try {
        anchor = section.querySelector(`#${CSS.escape(chapter.fragment)}`);
      } catch { /* an id no selector can express; fall through to [name] */ }
      if (!anchor) {
        anchor = section.querySelector(`[name="${chapter.fragment.replace(/["\\]/g, '\\$&')}"]`);
      }
    }

    // The block the entry lands in, measured BEFORE the marker goes in --
    // otherwise the marker's own text counts towards the length test.
    const block = (anchor ?? section.firstElementChild)?.closest('h1,h2,h3,h4,h5,h6,p,div,li');
    const text = block ? (block.textContent ?? '').replace(/\s+/g, ' ').trim() : '';

    const mark = document.createElement('span');
    mark.className = 'ath-mark';
    mark.textContent = chapter.token;
    if (anchor) anchor.insertAdjacentElement('beforebegin', mark);
    else section.insertBefore(mark, section.firstChild);

    if (block && block !== section && text && text.length <= headingMaxChars) {
      block.classList.add('ath-heading');
    }
  }
};

/**
 * Runs IN THE PAGE, between the two prints: writes the page numbers into
 * the contents. A 0 means the marker was never found, and that entry goes
 * without rather than pointing somewhere wrong.
 */
const FILL_FOLIOS = (pages: number[]) => {
  const rows = document.querySelectorAll('.ath-entry');
  pages.forEach((page, i) => {
    const row = rows[i];
    if (!row) return;
    if (page > 0) {
      const folio = row.querySelector('.ath-entry-folio');
      if (folio) folio.textContent = String(page);
    } else {
      row.setAttribute('data-ath-found', 'no');
    }
  });
};

/**
 * Which page each marker landed on, by reading the printed PDF back.
 *
 * This is the only way to know: Chromium paginates during print and tells
 * nobody, so the page a chapter starts on does not exist as a fact until
 * the PDF does. Hence markers -- printing a token at each chapter opening
 * and then asking the finished document where the tokens are, which is
 * exact, rather than measuring heights beforehand, which is a guess that
 * page breaks and widow control quietly invalidate.
 *
 * Whitespace is stripped from both sides of the comparison because text
 * extraction reports what the PDF's content stream contains, and a run of
 * glyphs can be split across several text-showing operators.
 *
 * Failure here costs the page numbers, not the book.
 */
async function findMarkerPages(
  pdfPath: string, tokens: string[],
): Promise<{ pages: number[]; pageCount: number }> {
  const pages = new Array(tokens.length).fill(0);
  try {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document_ = await pdfjs.getDocument({
      data: new Uint8Array(await readFile(pdfPath)),
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise;

    let remaining = tokens.length;
    for (let n = 1; n <= document_.numPages && remaining > 0; n++) {
      const page = await document_.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((item: any) => item.str ?? '').join('').replace(/\s+/g, '');
      for (let i = 0; i < tokens.length; i++) {
        if (pages[i] === 0 && text.includes(tokens[i])) {
          pages[i] = n;
          remaining--;
        }
      }
      page.cleanup();
    }

    const pageCount = document_.numPages;
    await document_.destroy();
    return { pages, pageCount };
  } catch (err) {
    console.warn('Could not number the contents page:', (err as Error).message);
    return { pages, pageCount: 0 };
  }
}

/** The contents page itself. Numbers are written in later, by FILL_FOLIOS. */
function contentsHtml(plan: ChapterPlan[]): string {
  const rows = plan.map((chapter) => (
    '<li class="ath-entry">'
    + `<span class="ath-entry-title">${escapeHtml(chapter.title)}</span>`
    + '<span class="ath-entry-leader"></span>'
    + '<span class="ath-entry-folio"></span>'
    + '</li>'
  )).join('');
  // No break-after: the first chapter's own break-before starts the next
  // page, and asking for both risks a blank one between them.
  return `<nav class="ath-contents"><h1 class="ath-contents-title">Contents</h1>`
    + `<ol class="ath-contents-list">${rows}</ol></nav>`;
}

async function buildCombinedHtml(zip: JSZip, opfPath: string, workDir: string): Promise<{ htmlPath: string; plan: ChapterPlan[] }> {
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
  // Which section each spine document became, so a TOC entry can be
  // resolved to a position in the combined document rather than to a
  // filename the page will never see. Positions, not attribute values,
  // because the browser side then needs no selector escaping at all.
  const sectionOf = new Map<string, number>();
  for (const href of spineHrefs) {
    const xhtml = await zip.file(href)?.async('string');
    if (!xhtml) continue;
    // .ath-chapter carries break-before: page, forcing each chapter onto
    // its own PDF page -- Chromium's print pipeline honors standard CSS
    // break properties.
    const key = zipKey(href);
    if (!sectionOf.has(key)) sectionOf.set(key, bodyChunks.length);
    bodyChunks.push(`<section class="ath-chapter">${extractBody(xhtml)}</section>`);
  }
  if (bodyChunks.length === 0) throw new Error('No spine chapters produced any content');

  // The book's own table of contents, resolved onto those sections. An
  // entry pointing outside the reading order (a cover page marked
  // linear="no", say) has nowhere to land and is dropped.
  const plan: ChapterPlan[] = [];
  for (const entry of await readTocEntries(zip)) {
    const sectionIndex = sectionOf.get(entry.target);
    if (sectionIndex === undefined) continue;
    if (plan.length >= MAX_CONTENTS_ENTRIES) break;
    plan.push({
      title: entry.title,
      sectionIndex,
      fragment: entry.fragment,
      token: markerToken(plan.length),
    });
  }

  // Reuses whichever stylesheet(s) the first chapter links to. Extend this
  // (e.g. union of all chapters' <link> tags) if a book uses per-chapter
  // stylesheets rather than one shared one -- the common case is one shared
  // stylesheet for the whole book.
  const firstChapterHtml = await zip.file(spineHrefs[0])?.async('string');
  const stylesheetLinks = [...(firstChapterHtml?.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi) ?? [])]
    .map((m) => m[0])
    .join('\n');

  // Order matters: BASE_CSS is a floor the book can override, the book's
  // own stylesheets come next, and ATHENAEUM_CSS last so the few things we
  // do insist on -- headings, dead links, the contents page -- win.
  // A contents page for one entry is not a contents page; the markers and
  // the page numbers behind it are still worth having either way, since
  // the reader navigates by them.
  const combinedHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${BASE_CSS}</style>
${stylesheetLinks}
<style>${ATHENAEUM_CSS}</style>
</head>
<body>
${plan.length >= CONTENTS_MIN_ENTRIES ? contentsHtml(plan) : ''}
${bodyChunks.join('\n')}
</body>
</html>`;

  // Written alongside the extracted chapters (inside opfDir) so the
  // stylesheet/image relative paths above resolve exactly the way they did
  // for the original chapter files.
  const outputPath = path.join(workDir, opfDir, '__combined__.html');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, combinedHtml, 'utf-8');
  return { htmlPath: outputPath, plan };
}

/**
 * Convert an epub to a PDF, and report where its chapters ended up.
 *
 * PRINTED TWICE, ON PURPOSE. A contents page has to state page numbers,
 * and page numbers do not exist until the book has been paginated -- but
 * paginating it with the contents page already in front is the only way
 * those numbers come out right, since the contents itself occupies pages
 * and pushes everything after it along. So:
 *
 *   1. print the book with the contents page present and its numbers
 *      blank. Pagination is now final, and the markers say where every
 *      chapter landed;
 *   2. read the markers back out of that PDF;
 *   3. write the numbers into the still-open page and print again.
 *
 * The second print cannot move anything, because a contents entry is one
 * fixed-height line whatever it says (see .ath-entry) -- so the numbers
 * describe the document they are printed in. The cost is one extra print
 * per book, once ever: the result is cached by the caller and a reader
 * only ever waits for it the first time a book is opened.
 */
export async function epubToPdf(
  epubPath: string, outputPdfPath: string, options: PdfPageOptions = {},
): Promise<EpubPdfResult> {
  const zip = await loadEpub(epubPath);
  const opfPath = await findOpfPath(zip);
  const workDir = await mkdtemp(path.join(tmpdir(), 'epub-'));

  const { htmlPath, plan } = await buildCombinedHtml(zip, opfPath, workDir);

  const browser = await chromium.launch(
    options.executablePath ? { executablePath: options.executablePath } : {},
  );
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
    await page.evaluate(MARK_CHAPTERS, [plan, HEADING_MAX_CHARS] as [ChapterPlan[], number]);

    const print = () => page.pdf({
      path: outputPdfPath,
      // Match these to your 3D page mesh's aspect ratio (PANEL_REACH/HINGE_LEN).
      width: options.width ?? '160mm',
      height: options.height ?? '220mm',
      printBackground: true, // without this, CSS background colors/images are silently dropped
      margin: options.margin ?? { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' },
    });

    await print();
    const { pages, pageCount } = await findMarkerPages(outputPdfPath, plan.map((c) => c.token));

    // With no contents page there is nothing to write into, and the first
    // print already is the finished book.
    if (plan.length >= CONTENTS_MIN_ENTRIES) {
      await page.evaluate(FILL_FOLIOS, pages);
      await print();
    }

    return {
      pageCount,
      chapters: plan
        .map((chapter, i) => ({ title: chapter.title, page: pages[i] }))
        .filter((chapter) => chapter.page > 0),
    };
  } finally {
    await browser.close();
  }
}

// CLI entry point: `node epubToPdf.ts input.epub output.pdf`
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [, , epubPath, outputPdfPath] = process.argv;
  if (!epubPath || !outputPdfPath) {
    console.error('Usage: node epubToPdf.ts <input.epub> <output.pdf>');
    process.exit(1);
  }
  epubToPdf(epubPath, outputPdfPath)
    .then(() => console.log(`Wrote ${outputPdfPath}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}