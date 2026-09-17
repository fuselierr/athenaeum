/**
 * Call numbers for the room's shelving.
 *
 * Library of Congress-ish: a class letter pair and the span of numbers that
 * section holds, climbing as you go round the room. They are not real
 * classifications and nothing is filed under them -- they exist so that a
 * section can be NAMED. "The fourth bay of the lower run" is a count you have
 * to work out from where you are standing; "PR 2500–2999" is a place, and a
 * label you can read off the shelf and say out loud.
 *
 * A BAY carries the span it holds; each SHELF in that bay carries where in the
 * span it starts, top shelf first -- which is the order a bay is read and
 * filled. Both are shown by the debug overlay (the ` key, debug/debugLabels.js),
 * which is where knowing one bay from another actually matters.
 */

// Enough classes for a wall of shelving several times over. In LC order, so a
// run of them reads like a library rather than a random draw.
const CLASSES = ['NA', 'ND', 'PA', 'PR', 'PS', 'PT', 'QA', 'QH', 'TR', 'Z'];
const SECTIONS_PER_CLASS = 4; // before the class letter moves on
const SPAN = 500; // numbers a section holds
const FIRST = 1000; // where each class starts counting

/** The class and the span the `order`th section holds. */
function rangeAt(order) {
  const className = CLASSES[Math.floor(order / SECTIONS_PER_CLASS) % CLASSES.length];
  const from = FIRST + (order % SECTIONS_PER_CLASS) * SPAN;
  return { className, from, to: from + SPAN - 1 };
}

/**
 * The call number of the `index`th section, counting from the first bay of the
 * first run. Deterministic: the same section is always the same number, which
 * is the only reason a label like this is worth anything.
 */
export function callNumberAt(index) {
  const { className, from, to } = rangeAt(Math.max(0, Math.floor(index)));
  return `${className} ${from}–${to}`;
}

/**
 * Where a SHELF inside a section starts: the section's span divided between its
 * rows, the top row first. A bay fills along its top shelf and then down to the
 * next, so the numbers climb the way a reader's eye does rather than the way
 * the geometry happens to be built.
 */
export function shelfNumberAt(index, row, rows) {
  const { className, from } = rangeAt(Math.max(0, Math.floor(index)));
  const step = Math.floor(SPAN / Math.max(1, rows));
  return `${className} ${from + Math.max(0, row) * step}`;
}

/**
 * Number a run of sections in place: each one gets `callNumber`, and so does
 * each shelf it has, counting on from `first`. Returns how many SECTIONS were
 * numbered, so the next run carries on where this one stopped.
 */
export function numberSections(sections, first = 0) {
  sections.forEach((section, i) => {
    const order = first + i;
    section.callNumber = callNumberAt(order);
    const shelves = section.shelves ?? [];
    shelves.forEach((shelf, row) => {
      shelf.callNumber = shelfNumberAt(order, row, shelves.length);
    });
  });
  return sections.length;
}
