/**
 * The world is metric: 1 unit = 1 metre.
 *
 * The desk and the lamp are both authored that way already -- desk.glb is
 * about 0.83 units tall and lamp.glb normalizes to 0.70 -- i.e. a real desk
 * and a real desk lamp. What was out of step was the BOOK, whose page
 * simulation is authored at a convenient working scale of its own
 * (config.js's PANEL_REACH of 1.4 and HINGE_LEN of 2.0), and the scene used
 * to be dragged up to meet it: the desk inflated to 7.8 units wide and the
 * lamp to 3.3 tall, so a "metre" meant nothing and every light range,
 * camera distance and drop height was in book-widths.
 *
 * Now the furniture loads at its authored size and the book is scaled down
 * to join it.
 *
 * WHY A GROUP SCALE RATHER THAN SMALLER CONSTANTS. Re-authoring
 * PANEL_REACH/HINGE_LEN/SPINE_GAP to metres would put the page simulation
 * on a different scale relative to a FIXED gravity, and a hinge's swing
 * period goes with the square root of its length -- every page would snap
 * roughly three times faster and every damping, air-cushion and easing
 * constant in config.js would need re-tuning. Scaling the render group
 * leaves the page mechanism in exactly the units it was tuned in and
 * changes only how big it draws. The one thing that has to follow the
 * scale is the book's PLACEMENT physics, which really does live in world
 * space -- see bookPlacement.js.
 */

/**
 * How much larger than life the furniture and the book are drawn.
 *
 * Strictly this should be 1 -- the models are metric and the point of this
 * module is that a metre means a metre. It is 1.5 because the scene simply
 * reads better with the desk and the book a little oversized against the
 * lamp, which is left at its true size. Kept as ONE number so "make it all
 * bigger" stays a one-line change instead of drifting into separate
 * hardcoded multipliers per model -- which is exactly how the bookshelf
 * ended up 4.2 metres tall.
 */
export const FURNITURE_SCALE = 1.5;

// A hardback page is about 16 cm across. config.js's starting PANEL_REACH
// (the spine-to-fore-edge reach) is 1.4, and main.js holds that fixed as
// BASE_PANEL_REACH while a loaded PDF's aspect ratio drives HINGE_LEN off
// it -- so anchoring on it keeps the book a constant real-world width
// whatever shape its pages are.
const TARGET_PAGE_WIDTH_M = 0.16;
const BASE_PANEL_REACH = 1.4;

export const BOOK_WORLD_SCALE = (TARGET_PAGE_WIDTH_M / BASE_PANEL_REACH) * FURNITURE_SCALE;
