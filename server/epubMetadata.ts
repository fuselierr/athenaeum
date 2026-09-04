// epubMetadata.ts
//
// Pulls the jacket material out of an epub: the cover image, and the
// title/author/blurb that a physical book prints on its spine and back.
//
// Kept separate from epubToPdf.ts on purpose. That module's job is the
// READING ORDER -- it walks <spine> and renders those documents to a PDF.
// The cover is deliberately not part of the reading order in most books
// (it is commonly marked linear="no", or declared only in <metadata> and
// never listed in the spine at all), so it has to be found a different
// way. Note the unrelated collision in the word "spine": epub's <spine>
// is the reading order, nothing to do with the physical spine of a book.
//
// There is no back-cover or spine ARTWORK to extract -- epub has no such
// concept, and carries a single cover image at most. Callers synthesize
// those from the cover colour plus the text fields returned here.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

export interface EpubCover {
  data: Buffer;
  mediaType: string; // e.g. "image/jpeg"
  extension: string; // e.g. ".jpg"
}

export interface EpubMetadata {
  title: string | null;
  author: string | null;
  description: string | null;
  cover: EpubCover | null;
}

const parser = () => new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

// fast-xml-parser gives a bare string for a text-only element but an object
// with '#text' once the element carries attributes (dc:creator almost always
// has opf:role/opf:file-as), so both shapes have to be handled.
function text(node: any): string | null {
  const first = asArray(node)[0];
  if (first == null) return null;
  const raw = typeof first === 'object' ? first['#text'] : first;
  if (raw == null) return null;
  const clean = String(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return clean || null;
}

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

export async function extractEpubMetadata(epubPath: string): Promise<EpubMetadata> {
  const zip = await JSZip.loadAsync(await readFile(epubPath));

  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  if (!containerXml) throw new Error('META-INF/container.xml not found -- not a valid epub');
  const rootfile = asArray(parser().parse(containerXml).container.rootfiles.rootfile)[0];
  const opfPath: string = rootfile['@_full-path'];

  const opfXml = await zip.file(opfPath)?.async('string');
  if (!opfXml) throw new Error(`OPF file not found at ${opfPath}`);
  const pkg = parser().parse(opfXml).package;
  const opfDir = path.posix.dirname(opfPath);

  const manifest = asArray<any>(pkg.manifest?.item);
  const metadata = pkg.metadata ?? {};

  return {
    title: text(metadata['dc:title']),
    author: text(metadata['dc:creator']),
    description: text(metadata['dc:description']),
    cover: await findCover(zip, pkg, manifest, metadata, opfDir),
  };
}

/**
 * Books declare their cover in several mutually-incompatible ways
 * depending on epub version and authoring tool, so this tries each in
 * turn, most authoritative first. The test book here is EPUB 2 and only
 * answers to route 2.
 */
async function findCover(
  zip: JSZip, pkg: any, manifest: any[], metadata: any, opfDir: string,
): Promise<EpubCover | null> {
  const isImage = (item: any) => String(item?.['@_media-type'] ?? '').startsWith('image/');
  const candidates: any[] = [];

  // 1. EPUB 3: the manifest item marks itself.
  candidates.push(...manifest.filter((i) => String(i['@_properties'] ?? '').split(/\s+/).includes('cover-image')));

  // 2. EPUB 2: <meta name="cover" content="<manifest id>"> in <metadata>.
  const coverMeta = asArray<any>(metadata.meta).find((m) => m?.['@_name'] === 'cover');
  if (coverMeta) {
    const byId = manifest.find((i) => i['@_id'] === coverMeta['@_content']);
    if (byId) candidates.push(byId);
  }

  // 3. <guide><reference type="cover">. Often points at an XHTML wrapper
  //    page rather than the image itself, so only usable when it happens
  //    to reference an image directly -- hence the isImage filter below.
  for (const ref of asArray<any>(pkg.guide?.reference).filter((r) => r?.['@_type'] === 'cover')) {
    const href = String(ref['@_href'] ?? '').split('#')[0];
    const byHref = manifest.find((i) => i['@_href'] === href);
    if (byHref) candidates.push(byHref);
  }

  // 4. Last resort: an image whose id or filename says "cover".
  candidates.push(...manifest.filter((i) => isImage(i) && /cover/i.test(`${i['@_id']} ${i['@_href']}`)));

  for (const item of candidates) {
    if (!isImage(item)) continue; // skips route 3's XHTML wrappers
    const entry = zip.file(path.posix.join(opfDir, String(item['@_href'])));
    if (!entry) continue;
    const data = await entry.async('nodebuffer');
    if (!data.length) continue;
    const mediaType = String(item['@_media-type']);
    return {
      data,
      mediaType,
      extension: EXT_BY_MEDIA_TYPE[mediaType] ?? path.posix.extname(String(item['@_href'])) ?? '.img',
    };
  }

  return null;
}
