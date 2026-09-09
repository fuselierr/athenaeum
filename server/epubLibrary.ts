// epubLibrary.ts
//
// Reads the shelf's library: the raw .epub files sitting in src/books,
// as opposed to the converted books in books/ that the reader itself
// serves. Nothing here converts anything -- the shelf only needs a title,
// an author, a cover and some idea of how long each book is.

import JSZip from 'jszip';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractEpubMetadata, type EpubCover } from './epubMetadata.ts';
import { readStructure, plainTextLength, type Chapter } from './epubToc.ts';

export interface LibraryBook {
  id: string;
  file: string;
  title: string | null;
  author: string | null;
  description: string | null;
  cover: EpubCover | null;
  characters: number;
  pages: number;
  /** Where each chapter starts, as 0..1 through the text. See epubToc.ts. */
  chapters: Chapter[];
}

// Characters of body text per printed page. A rough constant on purpose:
// it only has to order the shelf's spines by thickness sensibly, and any
// value in the 1500-2500 range does that identically once the square-root
// curve on the client has been through it.
const CHARS_PER_PAGE = 1800;

/**
 * Total characters of readable text in an epub.
 *
 * THE FALLBACK. readStructure measures the same thing over the declared
 * reading order, which is both more accurate and gives the chapter offsets
 * for free -- this is what happens when a book has no usable OPF at all:
 * every content document in the archive, in whatever order the zip lists
 * them, which is fine for a total.
 *
 * Measured from the documents rather than the file size, which is
 * dominated by images -- Gulliver's Travels is 2.5 MB and mostly plates,
 * while Crime and Punishment is 719 KB and far longer to read.
 */
async function countCharacters(zip: JSZip): Promise<number> {
  const documents = Object.keys(zip.files).filter(
    (name) => /\.(x?html?|htm)$/i.test(name) && !zip.files[name].dir,
  );

  let total = 0;
  for (const name of documents) {
    const html = await zip.file(name)?.async('string');
    if (!html) continue;
    total += plainTextLength(html);
  }
  return total;
}

/** URL-safe, readable, and stable across restarts. */
function slugify(name: string): string {
  return name
    .replace(/\.epub$/i, '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60) || 'book';
}

// Reading eleven epubs end to end is a second or two of work, and the
// folder does not change while the server is up -- so it is done once and
// held. `mtime` of the directory is the cheap check that nothing was
// added; a new file bumps it and the next request rebuilds.
let cache: { key: string; books: LibraryBook[] } | null = null;

export async function readLibrary(dir: string): Promise<LibraryBook[]> {
  let key: string;
  try {
    key = `${dir}:${(await stat(dir)).mtimeMs}`;
  } catch {
    return []; // no library folder at all
  }
  if (cache && cache.key === key) return cache.books;

  const names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.epub')).sort();

  const seen = new Set<string>();
  const books: LibraryBook[] = [];

  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const meta = await extractEpubMetadata(file);
      const zip = await JSZip.loadAsync(await readFile(file));
      const structure = await readStructure(zip);
      const characters = structure.characters || await countCharacters(zip);

      // Titles can collide (two editions of one book); ids must not.
      let id = slugify(meta.title ?? name);
      if (seen.has(id)) {
        let n = 2;
        while (seen.has(`${id}-${n}`)) n += 1;
        id = `${id}-${n}`;
      }
      seen.add(id);

      books.push({
        id,
        file,
        title: meta.title,
        author: meta.author,
        description: meta.description,
        cover: meta.cover,
        characters,
        pages: Math.max(1, Math.round(characters / CHARS_PER_PAGE)),
        chapters: structure.chapters,
      });
    } catch {
      // One unreadable epub should cost that book, not the whole shelf.
    }
  }

  cache = { key, books };
  return books;
}