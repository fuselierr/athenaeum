// epubToc.ts
//
// The reading order, and where each chapter falls inside it.
//
// WHY THIS IS AN ESTIMATE. The reader navigates by PDF page, and the PDF
// carries no chapter marks -- epubToPdf renders the spine documents end to
// end and pdf.js counts the pages that fell out. What both sides DO share
// is the reading order itself. So a chapter's position is measured in
// TEXT: count the characters in every spine document, and a chapter that
// begins at document N begins at (characters before N) / (characters in
// all of them). Multiply by the PDF's page count and that is the page it
// lands on -- within a page or two, which is all a chapter jump needs.
//
// Everything here degrades to nothing rather than throwing: a book with an
// unreadable or absent table of contents still shelves, still opens, and
// simply offers page navigation alone.

import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

export interface Chapter {
  title: string;
  start: number; // 0..1, fraction of the book's text before this chapter
}

export interface EpubStructure {
  characters: number;
  chapters: Chapter[];
}

/**
 * One table-of-contents entry, still pointing at the epub rather than at a
 * position -- the raw material both consumers work from.
 *
 * `readStructure` below turns these into text fractions for the shelf.
 * epubToPdf turns them into headings and a contents page, which needs the
 * anchor kept intact: `target` alone says which document a chapter is in,
 * and books that keep their whole text in one file need `fragment` to say
 * where in it.
 */
export interface TocEntry {
  title: string;
  target: string; // document path, normalised, relative to the zip root
  fragment: string; // the id within that document, or '' for its start
}

const parser = () => new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const asArray = <T>(v: T | T[] | undefined | null): T[] => (
  v == null ? [] : Array.isArray(v) ? v : [v]
);

/**
 * Characters of readable text in a content document.
 *
 * Markup is stripped so a verbosely-tagged epub does not read as a longer
 * book, and scripts and styles go first so their source is not counted as
 * prose.
 */
export function plainTextLength(html: string): number {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/** Decoded, anchor-free, normalised -- what a spine href can be matched on. */
function normaliseHref(href: string, baseDir: string): string {
  const clean = decodeURIComponent(String(href).split('#')[0].trim());
  return path.posix.normalize(baseDir ? path.posix.join(baseDir, clean) : clean);
}

/**
 * EPUB 3: the nav document, an XHTML file with <nav epub:type="toc">.
 *
 * Read with a regex rather than the XML parser on purpose. Nav documents
 * are XHTML written by hand and by a dozen different tools; the one thing
 * they all reliably contain is a flat run of anchors in reading order,
 * and that is all that is wanted here. Nesting is deliberately flattened:
 * a chapter and its sub-sections are all just places to jump to.
 */
function chaptersFromNav(xhtml: string): { title: string; href: string }[] {
  const toc = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][\s\S]*?<\/nav>/i.exec(xhtml);
  const scope = toc ? toc[0] : xhtml;
  const out: { title: string; href: string }[] = [];
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match = anchor.exec(scope);
  while (match) {
    const title = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title) out.push({ title, href: match[1] });
    match = anchor.exec(scope);
  }
  return out;
}

/** EPUB 2: the NCX, whose navPoints nest arbitrarily deep. */
function chaptersFromNcx(xml: string): { title: string; href: string }[] {
  const out: { title: string; href: string }[] = [];
  const walk = (points: any[]) => {
    for (const point of points) {
      const title = String(
        asArray<any>(point?.navLabel)[0]?.text ?? '',
      ).replace(/\s+/g, ' ').trim();
      const href = asArray<any>(point?.content)[0]?.['@_src'];
      if (title && href) out.push({ title, href: String(href) });
      // Depth is flattened for the same reason as the nav document: every
      // entry is somewhere to jump to, and the reader offers one list.
      walk(asArray<any>(point?.navPoint));
    }
  };
  walk(asArray<any>(parser().parse(xml)?.ncx?.navMap?.navPoint));
  return out;
}

/**
 * Where an id/name anchor sits in the raw markup, or -1.
 *
 * Position in the SOURCE, which is then converted to a position in the
 * text by measuring what comes before it -- markup length is not reading
 * length, and it is reading length the page estimate is built on.
 */
function findAnchor(html: string, fragment: string): number {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<[^>]*\\b(?:id|name)\\s*=\\s*["']${escaped}["']`, 'i').exec(html);
  return match ? match.index : -1;
}

/** The OPF -- the file that lists what a book contains and in what order. */
async function openPackage(zip: JSZip) {
  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  if (!containerXml) return null;
  const opfPath = String(
    asArray<any>(parser().parse(containerXml).container.rootfiles.rootfile)[0]['@_full-path'],
  );
  const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);

  const opfXml = await zip.file(opfPath)?.async('string');
  if (!opfXml) return null;
  const pkg = parser().parse(opfXml).package;
  const manifest = asArray<any>(pkg.manifest?.item);
  return {
    pkg,
    opfDir,
    manifest,
    byId: new Map(manifest.map((item) => [String(item['@_id']), item])),
  };
}

/**
 * A book's table of contents, as the book itself declares it.
 *
 * EPUB 3 keeps it in a nav document and EPUB 2 in an NCX; a great many
 * books in the wild carry both, or carry one while claiming the other.
 * Whichever is found first and yields entries wins, and a book with
 * neither simply has no chapters -- see the note at the top of the file.
 */
export async function readTocEntries(zip: JSZip): Promise<TocEntry[]> {
  try {
    const open = await openPackage(zip);
    if (!open) return [];
    const { pkg, opfDir, manifest, byId } = open;

    const navItem = manifest.find(
      (item) => String(item['@_properties'] ?? '').split(/\s+/).includes('nav'),
    );
    const ncxItem = byId.get(String(pkg.spine?.['@_toc'] ?? ''))
      ?? manifest.find((item) => String(item['@_media-type']) === 'application/x-dtbncx+xml');

    // Hrefs in a TOC are relative to the TOC's own location, which is not
    // always the OPF's -- hence resolving against the document that was
    // actually read rather than against opfDir.
    let raw: { title: string; href: string }[] = [];
    let tocDir = '';
    const readToc = async (item: any, parse: (text: string) => { title: string; href: string }[]) => {
      const href = normaliseHref(String(item['@_href']), opfDir);
      const text = await zip.file(href)?.async('string');
      if (!text) return;
      raw = parse(text);
      tocDir = path.posix.dirname(href) === '.' ? '' : path.posix.dirname(href);
    };

    if (navItem) await readToc(navItem, chaptersFromNav);
    if (raw.length === 0 && ncxItem) await readToc(ncxItem, chaptersFromNcx);

    return raw
      .map((entry) => {
        const [href, fragment] = String(entry.href).split('#');
        return {
          title: entry.title,
          // A bare "#anchor" has no document of its own to resolve to, so
          // it is dropped rather than guessed at -- see the filter below.
          target: href ? normaliseHref(href, tocDir) : '',
          fragment: fragment ? decodeURIComponent(fragment) : '',
        };
      })
      .filter((entry) => entry.target !== '');
  } catch {
    return [];
  }
}

/**
 * Read a book's reading order and table of contents out of an OPEN zip --
 * the caller usually has one already, and an epub is not worth unpacking
 * twice.
 */
export async function readStructure(zip: JSZip): Promise<EpubStructure> {
  const empty: EpubStructure = { characters: 0, chapters: [] };
  try {
    const open = await openPackage(zip);
    if (!open) return empty;
    const { pkg, opfDir, byId } = open;

    // --- the reading order, and how much text is in each part of it ------
    const spine: string[] = asArray<any>(pkg.spine?.itemref)
      .map((ref) => byId.get(String(ref['@_idref'])))
      .filter(Boolean)
      .map((item) => normaliseHref(String(item['@_href']), opfDir));

    const before = new Map<string, number>(); // spine href -> characters before it
    let characters = 0;
    for (const href of spine) {
      before.set(href, characters);
      const html = await zip.file(href)?.async('string');
      if (html) characters += plainTextLength(html);
    }
    if (characters === 0) return empty;

    const entries = await readTocEntries(zip);

    // Entries are placed by the document they point INTO, so an entry
    // whose target is not in the reading order (a cover page marked
    // linear="no", say) is dropped rather than guessed at.
    //
    // Entries are placed to the ANCHOR, not just to the document. Books
    // split one file per chapter and books that keep the whole text in one
    // file with a hundred ids in it are both common, and only measuring the
    // text before the anchor handles both: without it the second kind
    // collapses to a single chapter.
    const htmlCache = new Map<string, string>();
    const documentText = async (href: string) => {
      if (!htmlCache.has(href)) htmlCache.set(href, (await zip.file(href)?.async('string')) ?? '');
      return htmlCache.get(href) as string;
    };

    const chapters: Chapter[] = [];
    const seen = new Set<number>();
    for (const entry of entries) {
      const base = before.get(entry.target);
      if (base == null) continue;

      let offset = base;
      if (entry.fragment) {
        const html = await documentText(entry.target);
        const at = findAnchor(html, entry.fragment);
        if (at >= 0) offset = base + plainTextLength(html.slice(0, at));
      }

      // Two entries that land on the same text are one place to go -- an
      // anchor and the heading beside it, typically.
      const start = offset / characters;
      const key = Math.round(start * 100000);
      if (seen.has(key)) continue;
      seen.add(key);
      chapters.push({ title: entry.title, start });
    }
    chapters.sort((a, b) => a.start - b.start);

    return { characters, chapters };
  } catch {
    return empty; // a book with no usable structure still opens
  }
}