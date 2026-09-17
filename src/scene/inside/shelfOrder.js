/**
 * What order books stand in, for every shelf in the room: the standing
 * bookshelf (shelfBooks.js) and the runs built into the walls (shelfRows.js)
 * file themselves the same way, from the same setting (state/settings.js's
 * shelf.sort, the Scene tab).
 *
 * BY AUTHOR, TWO WAYS. As the name is written -- "Ursula K. Le Guin" under U --
 * or as a library files it, by the name the person is known by: "Le Guin,
 * Ursula K." under L. Neither is more correct; they are different questions.
 * The first is how a reader remembers a name, the second is how a shelf is
 * searched.
 */

// Words that belong to the surname rather than sitting before it: "Le Guin",
// "van Gogh", "de Beauvoir". Far from every language's rules -- this is a
// shelf, not a cataloguing standard -- but it covers the names a reader is
// likely to own and gets them off the wrong letter.
const PARTICLES = new Set([
  'af', 'al', 'av', 'bin', 'da', 'das', 'de', 'del', 'della', 'den', 'der',
  'di', 'dos', 'du', 'ibn', 'la', 'le', 'mac', 'mc', 'st', 'ten', 'ter',
  'van', 'von',
]);

// And words that are not part of the name at all.
const SUFFIXES = new Set(['jr', 'sr', 'i', 'ii', 'iii', 'iv', 'phd', 'md', 'esq']);

const plain = (value) => (value ?? '').toString().trim().toLowerCase();

/**
 * The name a person is filed under: their surname, with whatever particles
 * belong to it, and without a trailing Jr. or III.
 *
 * "Le Guin, Ursula K." is already filed -- anything before a comma is taken as
 * the surname and used as it stands.
 */
export function surnameOf(author) {
  const name = plain(author).replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return '';

  const comma = name.indexOf(',');
  if (comma > 0) return name.slice(0, comma).trim();

  const words = name.split(' ').filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words.length <= 1) return words[0] ?? '';

  let from = words.length - 1;
  while (from > 0 && PARTICLES.has(words[from - 1])) from -= 1;
  return words.slice(from).join(' ');
}

/**
 * The books in the order asked for.
 *
 * @param {Array<object>} items  whatever a shelf holds
 * @param {string} sort  'shelf' as they came, 'title', 'author' by the name as
 *   written, or 'surname' by the name it is filed under
 * @param {(item: object) => { title: string|null, author: string|null, filed: number }} read
 *   where to find a book's title, author, and the order it arrived in
 * @returns {Array<object>} a new array; the caller's is left alone
 */
export function inOrder(items, sort, read) {
  const title = (item) => plain(read(item).title);
  const author = (item) => plain(read(item).author);
  const byTitle = (a, b) => title(a).localeCompare(title(b));
  // One author's books stand together, in title order among themselves.
  const byAuthor = (a, b) => author(a).localeCompare(author(b)) || byTitle(a, b);

  const sorted = [...items];
  if (sort === 'title') sorted.sort(byTitle);
  else if (sort === 'author') sorted.sort(byAuthor);
  else if (sort === 'surname') {
    sorted.sort((a, b) => surnameOf(read(a).author).localeCompare(surnameOf(read(b).author))
      || byAuthor(a, b));
  } else sorted.sort((a, b) => read(a).filed - read(b).filed);
  return sorted;
}
