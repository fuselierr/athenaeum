import * as THREE from 'three';
import { createScene } from './scene/createScene.js';
import { loadDesk } from './scene/inside/desk.js';
import { loadLamp } from './scene/inside/lamp.js';
import { loadBookshelf } from './scene/inside/bookshelf.js';
import { addFloor } from './scene/inside/floor.js';
import { addRoom, WINDOW_SILL_PROJECTION, DOOR_TOP } from './scene/inside/room.js';
import { addRoomDaylight, ROOM_DAYLIGHT } from './scene/inside/roomDaylight.js';
import { createRoomBeams, addRoomDust } from './scene/inside/roomBeams.js';
import { CLOUDS } from './scene/outside/volumetricClouds.js';
import { loadRoomSurfaces } from './scene/inside/surfaces.js';
import { loadSofa } from './scene/inside/sofa.js';
import { loadRug } from './scene/inside/rug.js';
import { addCoffeeTable } from './scene/inside/coffeeTable.js';
import { addMezzanine, deckRise, MEZZANINE } from './scene/inside/mezzanine.js';
import { addFoliage } from './scene/inside/foliage.js';
import { addWallShelf } from './scene/inside/wallShelf.js';
import { numberSections } from './scene/inside/callNumbers.js';
import { createShelfRows } from './scene/inside/shelfRows.js';
import { populateShelf } from './scene/inside/shelfBooks.js';
import { addInstructionCard } from './scene/inside/instructionCard.js';
import { createOutside } from './scene/outside/outside.js';
import { createBookInstance } from './book/bookInstance.js';
import { install as focusBookConfig, capture as captureBookConfig }
  from './book/pageSim/bookContext.js';
import {
  PANEL_REACH as INITIAL_PANEL_REACH,
  HINGE_LEN,
} from './book/pageSim/config.js';
import { RIGHT_HAND_PANEL, LEFT_HAND_PANEL } from './book/reader/bookContent.js';
import { createDragCover } from './book/reader/dragCover.js';
import { createBookOpening } from './book/reader/bookOpening.js';
import { createDragPageTurn } from './book/reader/dragPageTurn.js';
import { createCameraPan } from './input/cameraPan.js';
import { createCameraModes, CAMERA_MODE } from './input/cameraModes.js';
import { createBookManipulator } from './input/bookManipulator.js';
import { createBookCarry } from './input/bookCarry.js';
import { createVRControls } from './input/vrControls.js';
import { mountVRButton } from './ui/vrButton.js';
import { checkGpu } from './ui/gpuNotice.js';
import { createDebugLabels } from './debug/debugLabels.js';
import { createAnglePanel } from './debug/anglePanel.js';
import { createOutdoorPanel } from './debug/outdoorPanel.js';
import { createFpsCounter } from './debug/fpsCounter.js';
import { createFacingPanel } from './debug/facingPanel.js';
import { createMezzaninePanel } from './debug/mezzaninePanel.js';
import { initBookLoader, openLibraryBook, uploadBook } from './loader/bookLoader.js';
import { createAudioManager } from './audio/audioManager.js';
import './ui/theme.css'; // the interface's colours, for every panel
import { loadingScreen } from './ui/loadingScreen.js';
import { mountMenu } from './ui/mountMenu.js';
import { mountAccount } from './ui/mountAccount.js';
import { mountLanding } from './ui/mountLanding.js';
import { bookControls } from './state/bookControls.js';
import { aimAtPointer, nearestShownHit, isWithin } from './scene/picking.js';
import { sessionReady } from './auth/session.js';
import { landing } from './state/landing.js';
import { world } from './state/world.js';
import { placeFor, startRememberingPlace } from './state/lastPlace.js';
import { bindSettings } from './ui/bindSettings.js';
import { book as bookState } from './state/book.js';
import { matches } from './state/keybindings.js';
import { settings } from './state/settings.js';
import { qualityPreset } from './state/quality.js';
import { watch } from 'vue';
import { account } from './state/account.js';
import { ui } from './state/ui.js';
import { community } from './state/community.js';
import { loadAttachments, rememberBook } from './community/covers.js';
import { startPreferencesSync } from './auth/preferences.js';

// Fixed spine-to-edge reach that the camera, lighting and SPINE_GAP are
// tuned around; a loaded PDF's aspect ratio derives HINGE_LEN from this
// rather than rescaling the whole book.
const BASE_PANEL_REACH = INITIAL_PANEL_REACH;

loadingScreen.status('Lighting the room…', 0.02, 0.2);
const { scene, camera, renderer, controls, environment } = await createScene();
// Which GPU the browser gave us -- and, if it is built-in graphics or none at
// all, how to get the better one. Waits under the loading screen until it lifts.
checkGpu(renderer);
const audio = createAudioManager();

// Camera rig first, before anything else listens on the canvas. It does not
// swallow presses: the book's own handlers get first claim, and a drag only
// looks around if none of them took it (see cameraModes.js). It still has to
// be first in line, because it switches OrbitControls off outside orbit
// mode before any press is handled, and capture-phase listeners on one
// element run in registration order.
const cameraPan = createCameraPan({ camera, controls });
// Settings reach the room through exactly one file, and the backdrop is
// loaded here rather than inside createScene: it is a SETTING now, so the
// stored choice is what decides which one the first frame gets.
const scenery = bindSettings({
  audio, camera, renderer, scene, environment,
});
await scenery.setBackground(scenery.initialBackground);

const cameraModes = createCameraModes({
  camera,
  renderer,
  controls,
  cameraPan,
  // Clicks arrive through the rig rather than a listener of the shelf's
  // own: in the look modes it swallows pointerdown on the canvas, so a
  // second listener would never hear one. `shelfBooks` is still loading at
  // this point, hence reading it through the closure.
  onClick: (event) => {
    // The instruction card first: while it is held up, any click is how it
    // goes back, and must not also take a book or set one down.
    if (instructionCard?.handleClick(event)) return;
    if (outside?.handleClick(event)) return; // the door
    // The book before the shelf: the shelf tests only its own books and
    // ignores what is in front of them, so a click on the book in your hand
    // would otherwise take down whichever shelf book is behind it.
    // Whichever book was clicked is the one this is about, so a click on any
    // of them takes THAT one up rather than the last one read.
    focusBookUnder(event);
    if (bookCarry?.handleClick(event)) return;
    // Outside, the shelf and the desk are not there to click -- the shelf's
    // own test does not know its books are hidden, and the desk's would set
    // the book down on nothing.
    if (outside?.outside) return;
    if (shelfBooks?.handleClick(event)) return;
    // The wall's shelves: holding a book, a click files it on THAT row; empty
    // handed, a click takes the book you clicked back down off it.
    if (bookCarry?.held) {
      const row = shelfRows?.rowUnder(event.clientX, event.clientY);
      if (row) {
        fileHeldBook(row);
        return;
      }
    } else {
      const filed = shelfRows?.filedUnder(event.clientX, event.clientY);
      // Only one that can be opened again: a book with no library record of its
      // own has nothing to load, and is better left standing.
      if (filed?.record?.id) {
        openFiledBook(filed);
        return;
      }
    }
    putBookDown(event); // a click past the shelf, holding a book
  },
  // A right-click on the bench outside, or anywhere on the sofa inside, sits
  // you down on it.
  onRightClick: (event) => {
    if (outside?.handleRightClick(event) || outside?.outside) return;
    const seat = sofa?.seatUnder(event, {
      camera,
      dom: renderer.domElement,
      occluders: [desk?.object, lamp, bookshelf, bookGroup],
    });
    if (seat) cameraModes.sitOn(seat);
  },
});

// THE BOOKS IN THE ROOM. Several at once, each its own size, its own physics
// and its own pages (book/bookInstance.js) -- you hold one of them, and the
// rest lie where they were left, still settling on the desk.
//
// Everything the reader does with their hands works on the book IN FOCUS, so
// these are `let`: focusOn() swaps them when another book comes off the shelf,
// and every handler below goes on reading `pages`, `content`, `placement` and
// `bookGroup` without knowing that happened.
const books = [];
// Past a handful, each copy is a physics world and a set of page textures, so
// the oldest one nobody is holding is let go of instead.
const MAX_BOOKS = 4;
let focused = null;
let pages = null;
let content = null;
let placement = null;
let bookGroup = null;
const getPages = () => pages;
const getContent = () => content;

const _pickRay = new THREE.Raycaster();

/**
 * The book under the pointer, or null.
 *
 * The whole scene is tested rather than the books alone, so something in front
 * of one -- the lamp, the instruction card, another book -- keeps the press;
 * and hidden things are skipped, because raycasting ignores `visible` and the
 * walls you have switched off would otherwise be in the way.
 */
function bookUnderPointer(clientX, clientY) {
  aimAtPointer(_pickRay, clientX, clientY, camera, renderer.domElement);
  const nearest = nearestShownHit(_pickRay, scene);
  return books.find((one) => isWithin(nearest?.object, one.group)) ?? null;
}

/**
 * The book a gesture landed on, brought into focus: a click takes THAT book up,
 * a shift-drag slides it, a right-drag turns it. You hold one book at a time,
 * so whatever is in your hands is let go of first and stays where it falls.
 */
function focusBookUnder(event) {
  const book = bookUnderPointer(event.clientX, event.clientY);
  if (!book || book === focused) return book;
  if (bookCarry?.carrying) bookCarry.letGo();
  focusOn(book);
  return book;
}

/** Work on this book from here on: it is the one in your hands. */
function focusOn(book) {
  focused = book;
  pages = book.pages;
  content = book.content;
  placement = book.placement;
  bookGroup = book.group;
  // Its dimensions are what the mechanism reads BETWEEN frames, which is when
  // a drag or a key press lands (book/pageSim/bookContext.js).
  focusBookConfig(book.config);
}

// The ground outside, while you are out on it: null in the room, where the
// floor and the furniture are what a book lands on. Read by every copy's
// placement physics through the getter passed to createBookInstance.
let outdoorGround = null;

/**
 * The ground a book's physics should stand on: the hillside if that BOOK is
 * out on it, and nothing -- its room, its desk, its furniture -- otherwise.
 *
 * Per book, not per trip. Going outside takes you out, not every book in the
 * room: the ones lying on the desk stay lying on the desk, and if their
 * physics were switched over to the hillside with yours they would drop
 * straight through a desk that had stopped existing, and be on the floor
 * when you came back in. A book is out there while it is in your hands
 * outside, or has been set down out there (leftOutside).
 */
function groundFor(book) {
  if (!outdoorGround) return null;
  const inHand = book === focused && bookCarry?.carrying;
  return inHand || leftOutside.has(book) ? outdoorGround : null;
}

// Books set down on the hillside and not picked up again. Outside they are
// drawn where they lie rather than vanishing the moment they leave your hand
// (createOutside's `book.outdoors`), and coming back in they are fetched home
// -- see the watch on world.place below.
const leftOutside = new Set();

// Taking the book up off the desk to read (input/bookCarry.js). Built once
// the placement physics exists, further down -- clicks can arrive sooner.
let bookCarry = null;

// The desk and lamp go straight under `scene`: they are furniture the book
// rests on, so they stay put in world space when the book itself is moved.
// Loaded alongside the page simulation since none of the three waits on
// the others.
loadingScreen.status('Arranging the furniture…', 0.2, 0.45);
const [desk, lamp, bookshelf, surfaces, sofa, rug] = await Promise.all([
  loadDesk(scene),
  // Lamp at its authored size, on the back corner of the desk.
  loadLamp(scene, { position: new THREE.Vector3(0.22, 0, -0.42) }),
  loadBookshelf(scene),
  // The floorboards and the plywood walls (scene/inside/surfaces.js).
  loadRoomSurfaces(),
  // Placed in the middle of the room once the room is measured, below.
  loadSofa(scene),
  // The carpet under the sofa and the coffee table, likewise.
  loadRug(scene),
]);

// --- arrange the room -----------------------------------------------------
// Done here rather than inside the loaders because it is a RELATIONSHIP
// between two models, and neither one can know the other's measurements at
// its own load time. Measured, not hardcoded, so swapping either .glb (or
// changing FURNITURE_SCALE) still lands them correctly.
const GAP_BEHIND_DESK = 5; // metres of clear floor between desk and shelf
// Clear floor past the furniture, on the two sides nothing backs onto.
// Wider than the bare 0.4 the floor used to take, because it is now the
// room you stand in as well as the ground the desk is on -- the walls land
// exactly on this edge.
//
// The other two sides get no margin at all: the shelf backs onto one and
// the desk onto the other, which is what puts them against a wall.
const ROOM_MARGIN = 1.7;
// How far a wall stops short of the furniture standing against it. Not a
// gap -- surfaces that are exactly coplanar z-fight, and a centimetre is
// under the threshold of anyone noticing while being well over the
// threshold of the depth buffer.
const FURNITURE_WALL_CLEARANCE = 0.01;
// How far the window's sill clears the desk top. The desk is against that
// wall, so a sill at the usual height would put the bottom of the opening
// behind it -- this is what keeps the whole window visible above the
// worktop, which is where you want it when you are sitting at it.
const SILL_ABOVE_DESK = 0.08;
// The back wall's window sits low: nothing stands against that wall -- the
// stair climbs across it (scene/inside/mezzanine.js).
const BACK_WINDOW_SILL = 0.5;
// The +Z wall is shelved for most of its length (scene/inside/wallShelf.js).
const WALL_SHELF_RUN = 0.76; // of that wall
const WALL_SHELF_END_GAP = 0; // off the corner it starts from
const WALL_SHELF_HEIGHT = 2.4; // upstairs, unless the ceiling is lower than that
// The sofa stands this far back from the middle of the room, toward the
// bookshelf (-X), leaving room in front of it for the coffee table.
const SOFA_BACK = 0.9;
// Clear floor between the front of the sofa and the edge of the coffee table:
// room for your knees, near enough to reach a cup.
const SOFA_TO_TABLE = 0.42;
// Where the carpet's middle is, back from the table's toward the sofa -- so the
// sofa's front legs stand on it and the table sits in its middle.
const RUG_BACK_FROM_TABLE = 0.2;
// The storey above the balcony is wider than the one below it: its +X and +Z
// walls stand this much further out, and the balcony runs out to meet them
// (scene/inside/room.js's upper). Kept with the mezzanine's other sizes
// (scene/inside/mezzanine.js's MEZZANINE), where the debug overlay can change
// them for the next load.
const UPPER_GROW_X = MEZZANINE.upperGrowX;
const UPPER_GROW_Z = MEZZANINE.upperGrowZ;
// The upper storey's windows in the +X wall: this far above the balcony floor.
const UPPER_WINDOW_SILL = 0.8;
// The door is in the bookshelf wall (-X), up in its +Z corner: this is how far
// the middle of it stands off that corner.
const DOOR_FROM_CORNER = 0.9;
// Above the tallest thing in the room. A ceiling that only just clears the
// bookshelf reads as an attic, so give the room a bit more breathing room.
const CEILING_CLEARANCE = 1.6;
const MIN_CEILING_HEIGHT = 6.5;

// The room's inside, floor to ceiling and wall to wall. Filled in by the
// block below once the walls exist, and handed to the book's physics, which
// keeps the book within it.
let roomInterior = null;
// The framed instructions on the desk. Set in the block below, once the desk
// has been measured; clicks and Escape reach it through here.
let instructionCard = null;
// The door out, and what is beyond it (scene/outside/outside.js). Set in the block
// below, once the room exists.
let outside = null;
// The balcony and its stair (scene/inside/mezzanine.js), and the ground they
// make of the room: floor, stair and deck in one. Indoors walks on that the way
// outside walks on the terrain, so coming back in has to put it back.
let mezzanine = null;
let indoorGround = null;
// The shelves built into the +Z wall (scene/inside/wallShelf.js): one run on
// the floor, and the same run again on the balcony above it.
let wallShelf = null;
let deckShelf = null;
// Vines on the windows and the balcony, and the potted plants
// (scene/inside/foliage.js).
let foliage = null;
// The coffee table in front of the sofa (scene/inside/coffeeTable.js).
let coffeeTable = null;
// The sun and the sky through the windows (scene/inside/roomDaylight.js), and
// the beams and the dust it makes in the room's air (scene/inside/roomBeams.js).
let roomDaylight = null;
let roomBeams = null;
let roomDust = null;
// Build the mezzanine again from its values, and regrow what grows on it --
// for the debug overlay's sliders (debug/mezzaninePanel.js). Set in the block
// below, which has everything they were first built from.
let rebuildMezzanine = () => {};
let regrowFoliage = () => {};
{
  const deskBox = new THREE.Box3().setFromObject(desk.object);

  // How to use the room, framed on the desk's back-right corner, against the
  // window wall.
  instructionCard = addInstructionCard(scene, { deskBox, renderer, camera });

  // BEHIND IS -X. desk.js rotates the desk by PI/2, so the desk's depth
  // runs along X rather than Z, and the far side from the viewer is its
  // -X edge.
  //
  // Turn the shelf to match before measuring it: at rotationY 0 its front
  // faces +Z (which is why its own default position put it at -Z), and
  // +PI/2 swings that round to +X -- out of the back wall, facing the desk.
  bookshelf.updateMatrixWorld(true);

  const shelfBox = new THREE.Box3().setFromObject(bookshelf);
  const shelfDepth = shelfBox.max.x - shelfBox.min.x;

  // loadBookshelf recentres the model horizontally on its own origin and
  // puts its feet at that origin, so: X places the FRONT face a set gap
  // past the desk's back edge, Y drops the feet to the floor -- NOT 0,
  // which is the desk's TOP surface -- and Z lines it up with the desk.
  bookshelf.position.set(
    deskBox.min.x - GAP_BEHIND_DESK - shelfDepth / 2,
    deskBox.min.y,
    (deskBox.min.z + deskBox.max.z) / 2,
  );
  bookshelf.updateMatrixWorld(true);

  // Measured AFTER the move: this is where the shelf actually ended up, and
  // the back wall is built onto it. The union's min.y is the lowest foot in
  // the room, which is what the floor sits at.
  const placedShelf = new THREE.Box3().setFromObject(bookshelf);
  const room = deskBox.clone().union(placedShelf);

  // The room's footprint. Worked out here rather than left to addFloor's
  // own margin because that margin is uniform and this one deliberately is
  // not -- and because the floor and the walls have to agree on it to the
  // millimetre, the walls being built on the floor's own box.
  const footprint = room.clone();
  footprint.min.z -= ROOM_MARGIN;
  footprint.max.z += ROOM_MARGIN;
  // Both long walls come to meet their furniture instead of standing off
  // it. The back wall goes onto the shelf's own back panel; the window wall
  // comes to the desk, less the depth of the sill -- which overhangs the
  // room, and would otherwise be sitting on the worktop. Taken from the
  // window's own measurements so the two cannot drift apart.
  footprint.min.x = placedShelf.min.x - FURNITURE_WALL_CLEARANCE;
  footprint.max.x = deskBox.max.x + FURNITURE_WALL_CLEARANCE + WINDOW_SILL_PROJECTION;

  const floor = addFloor(scene, footprint, { margin: 0, material: surfaces.floor });
  // Where the shelved run of the +Z wall begins. Worked out here because the
  // walls are built from this same footprint, below.
  const shelvedFrom = footprint.max.x - WALL_SHELF_END_GAP
    - (footprint.max.x - footprint.min.x) * WALL_SHELF_RUN;
  // The floor IS the walkable area, so the first-person mode takes its
  // bounds from the mesh rather than recomputing them.
  const walkable = new THREE.Box3().setFromObject(floor);
  cameraModes.setRoom(walkable);

  // The sofa, a little back from the middle of the floor, facing the window
  // and the desk (+X); the coffee table in front of it; and the carpet under
  // the two -- the sofa's front legs on it, the table in its middle.
  const roomMiddle = walkable.getCenter(new THREE.Vector3());
  sofa.place({
    x: roomMiddle.x - SOFA_BACK,
    y: walkable.min.y,
    z: roomMiddle.z,
    facing: new THREE.Vector3(1, 0, 0),
  });
  const sofaFront = new THREE.Box3().setFromObject(sofa.object).max.x;
  coffeeTable = addCoffeeTable(scene);
  const tableX = sofaFront + SOFA_TO_TABLE + coffeeTable.radius;
  coffeeTable.place({ x: tableX, y: walkable.min.y, z: roomMiddle.z });
  rug.place({ x: tableX - RUG_BACK_FROM_TABLE, y: walkable.min.y, z: roomMiddle.z });

  // How high the balcony stands -- which is also where the room's upper,
  // wider storey begins -- worked out before either exists, so the walls and
  // the deck agree on it (scene/inside/mezzanine.js's deckRise).
  const roomHeight = Math.max(MIN_CEILING_HEIGHT, room.max.y - room.min.y + CEILING_CLEARANCE);
  const rise = deckRise({
    floorY: walkable.min.y,
    ceilingY: walkable.min.y + roomHeight,
    shelfTop: placedShelf.max.y,
    doorTop: walkable.min.y + DOOR_TOP,
  });

  // Walls and ceiling on that same footprint, stepping out on the +X and +Z
  // sides above the balcony. The windows over the desk go in the wall opposite
  // the bookshelf -- the shelf stands at -X (see above), so the wall the desk
  // is pushed up against is +X, and they are then directly in front of anyone
  // sitting at it.
  const shell = addRoom(scene, floor, {
    height: roomHeight,
    upper: { from: rise, grow: { x: UPPER_GROW_X, z: UPPER_GROW_Z } },
    focus: deskBox.getCenter(new THREE.Vector3()),
    windows: [
      // The row the desk is pushed up against, on the lower storey. Its sill is
      // measured from the floor, which is not y = 0: the desk's TOP is the
      // origin here, and the furniture is scaled, so the drop to the floor is
      // whatever the model says it is rather than a number written down.
      { side: '+x', storey: 'lower', sill: (deskBox.max.y - room.min.y) + SILL_ABOVE_DESK },
      // And a second row in the same wall's upper storey, which stands further
      // out: the light for the balcony.
      {
        side: '+x',
        storey: 'upper',
        sill: UPPER_WINDOW_SILL,
        focus: new THREE.Vector3(roomMiddle.x, walkable.min.y + rise + 1, roomMiddle.z),
      },
      // And a tall row filling the back wall, which the stair climbs across
      // and the balcony looks along -- taller windows, so more panes up each
      // one.
      {
        side: '-z',
        sill: BACK_WINDOW_SILL,
        width: 0.78,
        maxWidth: 5.6,
        columns: 2,
        rows: 4,
        focus: new THREE.Vector3(roomMiddle.x, walkable.min.y + 1.2, roomMiddle.z),
      },
    ],
    // In the bookshelf wall, up in its +Z corner. `along` is a world
    // coordinate down the wall, which for the -X wall is z.
    door: { side: '-x', along: footprint.max.z - DOOR_FROM_CORNER },
    wallMaterial: surfaces.walls,
    ceilingMaterial: surfaces.pine,
  });
  // Daylight through those windows: the sun where it stands outside at the
  // time of day set, shut out by the walls everywhere but the glass, and the
  // sky's soft light off each row of them. Over the whole room, both storeys.
  const roomBox = new THREE.Box3(
    walkable.min.clone(),
    new THREE.Vector3(
      shell.upper?.box.max.x ?? walkable.max.x,
      walkable.min.y + roomHeight,
      shell.upper?.box.max.z ?? walkable.max.z,
    ),
  );
  roomDaylight = addRoomDaylight({
    group: shell.group,
    box: roomBox,
    windows: shell.windows,
    hours: () => settings.outside.timeOfDay,
    // The sky the windows look out on is the one outside: overcast when its
    // clouds would make it so (scene/outside/outdoorLight.js's overcastFor).
    coverage: () => CLOUDS.coverage,
    enclosed: () => settings.graphics.walls,
  });
  watch(() => settings.graphics.walls, () => roomDaylight.refresh());
  // The beams that sun makes in the air, and the dust that glints in them --
  // the room's frame is drawn through these from now on.
  roomBeams = createRoomBeams({
    renderer, scene, camera, sun: roomDaylight.sun, box: roomBox, values: ROOM_DAYLIGHT,
  });
  roomDust = addRoomDust({ group: shell.group, sun: roomDaylight.sun, box: roomBox, values: ROOM_DAYLIGHT });
  // How finely the beams are walked, and how much dust (state/quality.js).
  watch(() => settings.graphics.quality, () => {
    const preset = qualityPreset();
    roomBeams.applyQuality(preset);
    roomDust.setCount(preset.dust);
  }, { immediate: true });
  // The balcony and the stair up to it: the flight climbs away from the back
  // wall toward the shelves, turning left onto a deck that runs to the door
  // wall and then back along it over the door. Built here because it is
  // measured off the room's own floor, ceiling, shelf and doorway.
  const ceilingY = shell.ceiling.getWorldPosition(new THREE.Vector3()).y;
  const mezzanineOptions = {
    camera,
    floorBox: walkable,
    ceilingY,
    shelfBox: placedShelf,
    doorBox: new THREE.Box3().setFromObject(shell.door),
    rise,
    grow: { x: UPPER_GROW_X, z: UPPER_GROW_Z },
    deckMaterial: surfaces.floor,
    woodMaterial: surfaces.pine,
  };
  mezzanine = addMezzanine(scene, mezzanineOptions);
  // The room is uneven ground now, so walking asks how high it is underfoot --
  // the same way it does outside.
  indoorGround = mezzanine.ground;
  cameraModes.setGround(indoorGround);

  // The shelves built into the +Z wall, floor to balcony: the head of the run
  // meets the underside of the deck over it, however high that stands.
  wallShelf = addWallShelf(scene, {
    minX: shelvedFrom,
    maxX: footprint.max.x - WALL_SHELF_END_GAP,
    wallZ: footprint.max.z,
    floorY: walkable.min.y,
    height: mezzanine.underY - walkable.min.y,
    material: surfaces.pine,
  });
  // And the same run again upstairs, standing on the balcony that crosses the
  // same wall -- wearing the material of the one below, so the pair costs two
  // draws rather than two of everything.
  deckShelf = addWallShelf(scene, {
    minX: shelvedFrom,
    maxX: footprint.max.x + UPPER_GROW_X - WALL_SHELF_END_GAP,
    // Against the upper storey's +Z wall, which stands further out.
    wallZ: footprint.max.z + UPPER_GROW_Z,
    floorY: mezzanine.deckY,
    height: Math.min(WALL_SHELF_HEIGHT, ceilingY - mezzanine.deckY - 0.4),
    material: wallShelf.object.material,
  });

  // Green things: vines up the windows and over the balcony, and potted
  // plants where they look at home -- grown to fit the room as it was just
  // measured, so after everything they grow on or stand beside.
  const foliageOptions = {
    room: shell,
    floorBox: walkable,
    deskBox,
    sofaBox: new THREE.Box3().setFromObject(sofa.object),
    shelfBox: placedShelf,
  };
  foliage = addFoliage(scene, { ...foliageOptions, mezzanine });

  // The same again, for the debug sliders. The deck they cannot move, but the
  // flight's shape can move the back end of it where the stair comes up, so
  // the books' furniture is given the new deck -- books made from now on land
  // on it; one already in the room keeps the deck it was made with.
  rebuildMezzanine = () => {
    const old = mezzanine;
    old.dispose();
    mezzanine = addMezzanine(scene, mezzanineOptions);
    indoorGround = mezzanine.ground;
    if (!outdoorGround) cameraModes.setGround(indoorGround);
    for (let i = FURNITURE.length - 1; i >= 0; i--) {
      if (old.collision.includes(FURNITURE[i])) FURNITURE.splice(i, 1);
    }
    FURNITURE.push(...mezzanine.collision);
  };
  regrowFoliage = () => {
    foliage.dispose();
    foliage = addFoliage(scene, { ...foliageOptions, mezzanine });
    foliage.setDensity(qualityPreset().foliageDensity);
  };
  // As many leaves as the graphics quality affords (state/quality.js).
  watch(() => settings.graphics.quality, () => {
    foliage.setDensity(qualityPreset().foliageDensity);
  }, { immediate: true });

  outside = createOutside({
    scene,
    camera,
    renderer,
    room: shell,
    floor,
    // The rest of the room, not drawn while outside. The shelf's books ride
    // on the shelf, and the lamp's lights on the lamp. A function, read each
    // time you go out, because the wall shelves' filed books (shelfRows) are
    // made further down this file than this.
    inside: () => [
      desk.object,
      lamp,
      bookshelf,
      sofa.object,
      coffeeTable.object,
      rug.object,
      mezzanine.group,
      wallShelf.object,
      deckShelf.object,
      foliage.group,
      instructionCard.group,
      // The books filed on the wall shelves stand in a group of their own,
      // not on the shelving -- without this they stayed standing in the
      // meadow, where the wall used to be.
      shelfRows?.object,
      scene.getObjectByName('roomFill'),
    ],
    // A book is outside if you are holding it, or if you put it down out
    // there (Q) and have not picked it up again.
    book: {
      objects: () => books.map((one) => one.group),
      isOutdoors: (group) => (group === bookGroup && Boolean(bookCarry?.carrying))
        || books.some((one) => one.group === group && leftOutside.has(one)),
    },
    // Outside, you walk on the terrain rather than the room's floor -- and
    // coming back in, on the room's own floor, stair and balcony again. The
    // books are told the same thing: it is what a dropped one lands on out
    // there, where the room's floor is somewhere behind you
    // (book/placement/bookPlacement.js).
    setGround: (ground) => {
      outdoorGround = ground ?? null;
      cameraModes.setGround(ground ?? indoorGround);
    },
    // Sitting or lying down (X), for the grass to part round you.
    lying: () => cameraModes.lying,
    // Right-clicking the bench.
    sit: (seat, options) => cameraModes.sitOn(seat, options),
    // Outside in VR, the exposure is metered off the land around you -- not
    // off the controllers and the menu in front of your face.
    vrHidden: () => vr.overlay,
  });
  // The walls-and-ceiling setting (the key, or Settings -> View) reaches the
  // room from here on.
  scenery.bindRoom(shell);

  // The room lit by a picture of itself rather than by the open sky -- walls,
  // ceiling and balcony in the way, the light coming in at the windows
  // (scene/createScene.js's lightFromRoom). Taken from the middle of the lower
  // storey at about head height, now that everything in it is built.
  environment.lightFromRoom({
    at: new THREE.Vector3(roomMiddle.x, walkable.min.y + 1.7, roomMiddle.z),
    enclosed: () => settings.graphics.walls,
    here: () => world.place === 'room',
  });
  // Back in from outside, it is taken again if the walls changed while you were out.
  watch(() => world.place, (place) => {
    if (place === 'room') environment.refreshRoom({ onlyIfOwed: true });
  });

  // The time of day moves the sun through the windows at once, and the
  // picture the room is lit by follows once the slider has stopped -- taking
  // it on every step of a drag would stall the frame each time.
  const RELIGHT_AFTER = 400; // ms
  let relight = null;
  watch(() => settings.outside.timeOfDay, () => {
    roomDaylight.refresh();
    clearTimeout(relight);
    relight = setTimeout(() => environment.refreshRoom(), RELIGHT_AFTER);
  });

  // Start on your feet between the coffee table and the desk, facing the
  // window. Walk is the default mode, and this is the first moment it can
  // begin: there is a floor to stand on and a window to face. Aim slightly
  // below eye level so the desk remains present in the opening view.
  const tableFarEdge = tableX + coffeeTable.radius;
  cameraModes.setMode(CAMERA_MODE.WALK);
  cameraModes.standAt((tableFarEdge + deskBox.min.x) / 2, roomMiddle.z);
  cameraModes.lookAt(new THREE.Vector3(
    shell.window.centre.x,
    camera.position.y - 0.4,
    shell.window.centre.z,
  ));

  // The floor's footprint, raised to the ceiling. The floor is a flat plane,
  // so its box is only as tall as the floor itself; the ceiling's own world
  // position supplies the height rather than restating addRoom's arithmetic.
  // Out to the upper storey's walls, which stand further out than the lower
  // storey's: a book put down up there has room to lie.
  roomInterior = new THREE.Box3(
    walkable.min.clone(),
    new THREE.Vector3(
      shell.upper?.box.max.x ?? walkable.max.x,
      shell.ceiling.getWorldPosition(new THREE.Vector3()).y,
      shell.upper?.box.max.z ?? walkable.max.z,
    ),
  );
}

// After the shelf has been turned and placed: the books measure it in its
// own frame, which needs its final transform to be settled.
// Assigned when the models finish loading; the render loop skips it until
// then rather than blocking the whole scene on scenery.
let shelfBooks = null;

// The loading screen stays up until the shelf is filled -- but never lifts
// before the room has drawn at least once, or it would fade onto a blank
// canvas for however long the rest of startup takes. Resolved by the render
// loop's first frame.
let markFirstFrame;
const firstFrame = new Promise((resolve) => { markFirstFrame = resolve; });
let libraryAnswered = true;

populateShelf(bookshelf, {
  camera,
  renderer,
  onProgress: ({ stage, done, total }) => {
    if (stage === 'fetching') loadingScreen.status('Fetching your library…', 0.45, 0.55);
    if (stage === 'unavailable') libraryAnswered = false;
    if (stage === 'shelving' && total > 0) {
      // The last 45% is the shelf, a book at a time, creeping toward the next.
      loadingScreen.status(
        `Shelving books… ${done} of ${total}`,
        0.55 + 0.45 * (done / total),
        0.55 + 0.45 * (Math.min(done + 1, total) / total),
      );
    }
  },
  // Taking a book off the shelf is what opens it. The conversion is fired
  // and forgotten: `openSequence` inside is what makes a book that was put
  // back mid-render simply never arrive.
  onTake: (record) => {
    // A book from the desk in the hand goes back first: one book in hand.
    if (record) bookCarry?.putBack();
    if (record) openFromShelf(record);
    else openSequence += 1;
  },
})
  .then((result) => {
    shelfBooks = result;
    // Standing the way the reader last left it (state/settings.js).
    result.arrange(settings.shelf);
    // What the Community tab can put a cover on -- and any covers already on them.
    community.books = result.books;
    applyDesigns();
  })
  .catch((err) => {
    console.error('Shelf books failed to load:', err);
    libraryAnswered = false;
  })
  .then(() => firstFrame)
  // Whether anyone is signed in decides what is behind the loading screen
  // when it lifts, so it is settled BEFORE lifting it rather than corrected
  // a moment later in front of the reader.
  .then(() => sessionReady())
  .then(() => openTheDoors());

/**
 * What the reader arrives to, once the room is standing.
 *
 *   NOT SIGNED IN -- the welcome page (ui/LandingScreen.vue). Put up first,
 *     so the cover comes off onto the welcome rather than onto a room they
 *     were not offered.
 *   SIGNED IN -- where they were when they closed the tab
 *     (state/lastPlace.js). Coming back outside, the door is opened while
 *     the loading screen is still up and goOutside() takes it down at the
 *     end, so it reads as one load rather than two.
 *
 * Only after that does the place start being written down: the world begins
 * every visit in the room, and a watcher running any earlier would record
 * 'room' over the 'outside' it is about to be asked for.
 */
/**
 * Put up the "headphones are recommended" card (ui/HeadphonesHint.vue), as
 * someone arrives in a scene: every time for a visitor who is not signed in,
 * who has no account for it to be remembered against -- and once ever for a
 * reader who is, remembered in their settings so it follows the account.
 */
function recommendHeadphones() {
  if (account.user) {
    if (settings.seen.headphones) return;
    settings.seen.headphones = true;
  }
  ui.headphonesHint = true;
}

async function openTheDoors() {
  // Up before the cover comes off, whatever else is wrong: a shelf that
  // would not load is all the more reason to offer someone a book of their
  // own.
  if (!account.user) landing.showing = true;

  const resuming = Boolean(account.user && outside && placeFor(account.user.id) === 'outside');
  if (resuming) {
    // Takes the loading screen down itself when the hillside is ready -- and
    // the shelf's trouble, if it had any, is not worth a message in front of
    // a door that is already opening onto a place with no shelf in it.
    await outside.goOutside();
  } else if (libraryAnswered) {
    loadingScreen.finish();
  } else {
    loadingScreen.fail('The library isn’t answering, so the shelf is empty for now.');
  }
  // Signed in, they are in the scene now. Signed out, they are on the welcome
  // page, and are told once they leave it (startOutsideWith).
  if (account.user) recommendHeadphones();
  startRememberingPlace();
}

// --- shared covers (the Community tab) -------------------------------------
// Which shared cover each of your books wears is kept in your account
// (community/covers.js); the shelf models follow it. It is read again
// whenever someone signs in or out, and signed out every book wears its own.
function applyDesigns() {
  if (!shelfBooks) return;
  for (const { id } of community.books) {
    shelfBooks.setDesign(id, community.attachments[id] ?? null)
      .catch((err) => console.error(`Shared cover failed to apply to ${id}:`, err));
  }
}
watch(() => community.attachments, applyDesigns);
watch(() => account.user?.id ?? null, () => {
  loadAttachments().catch((err) => {
    console.error('Could not read your shared covers:', err);
    community.error = `Couldn’t read which covers your books wear: ${err.message}`;
  });
}, { immediate: true });

// What a book has to land on and stay inside, now that the room is measured.
const FURNITURE = [
  ...sofa.collision,
  ...(coffeeTable?.collision ?? []),
  ...(mezzanine?.collision ?? []),
  ...(wallShelf?.collision ?? []),
  ...(deckShelf?.collision ?? []),
];

/**
 * Another copy on the desk: its own size, its own physics world, its own pages.
 * It falls, lands and settles on whichever cover is underneath, like the first.
 */
async function addBook({ at = null } = {}) {
  const book = await createBookInstance({
    scene, desk, room: roomInterior, obstacles: FURNITURE, at,
    // Asked every frame, not captured: a copy made in the room is the same
    // copy you carry outside. See groundFor.
    getGround: () => groundFor(book),
  });
  books.push(book);
  while (books.length > MAX_BOOKS) {
    const spare = books.find((one) => one !== book && one !== focused);
    if (!spare) break;
    books.splice(books.indexOf(spare), 1);
    spare.dispose();
  }
  return book;
}

/**
 * Take a fresh copy. You hold one book at a time, so whatever is in your hands
 * is let go of first -- and stays where it falls rather than going anywhere.
 */
async function takeFreshCopy() {
  bookCarry?.letGo();
  const book = await addBook();
  focusOn(book);
  return book;
}

/**
 * Every book in the room back on its shelf: the copies are let go of, the shelf
 * stands its own models up again, and the desk is left as it was when you came
 * in -- one book on it, nothing open. The Scene tab's "shelve books".
 */
async function shelveBooks() {
  // Anything still loading is abandoned, and anything in hand let go of.
  openSequence += 1;
  bookCarry?.letGo();
  shelfBooks?.release();

  // A fresh copy is focused BEFORE the old ones go: everything downstream reads
  // the book in focus, and there must never be a frame without one.
  const cleared = books.splice(0, books.length);
  focused = null;
  focusOn(await addBook());
  for (const book of cleared) book.dispose();

  shelfBooks?.shelveAll(settings.shelf);

  jacket = null;
  jacketBookId = null;
  bookState.id = null;
  bookState.title = '';
  bookState.author = null;
  bookState.chapters = [];
  bookState.status = '';
}

/**
 * File the book in your hands on a row of the wall's shelves: it becomes one of
 * the books standing there (scene/inside/shelfRows.js), laid out with the rest
 * of that row, and the copy that was in the room is let go of -- a shelved book
 * has nothing left to simulate.
 */
/**
 * The pose the real book has to be in for its shut self to sit exactly where a
 * shelf model does: the model's own pose with the book's shut offset taken back
 * out of it. The same arithmetic the standing shelf does when it swaps a model
 * for the book (shelfBooks' mirrorTo), for a slot on the wall.
 */
function poseAtSlot(slot) {
  const shut = pages.close(SHUT_ON);
  const scale = slot.size.length / HINGE_LEN;
  bookGroup.scale.setScalar(scale);
  const quaternion = slot.quaternion.clone().multiply(shut.quaternion.clone().invert());
  const position = slot.position.clone()
    .sub(shut.centre.clone().multiplyScalar(scale).applyQuaternion(quaternion));
  return { position, quaternion };
}

/** The copy in focus leaves the room: another is focused first, then it goes. */
function letCopyGo(book) {
  const at = books.indexOf(book);
  if (at >= 0) books.splice(at, 1);
  // Callers focus a spare first; this is the belt and braces, because a frame
  // with nothing in focus is a frame that throws.
  if (focused === book) {
    const spare = books[books.length - 1];
    if (spare) focusOn(spare);
  }
  book.dispose();
  jacket = null;
  jacketBookId = null;
  bookState.id = null;
  bookState.title = '';
  bookState.author = null;
  bookState.chapters = [];
}

/** Take a book down off one of the wall's shelves and open it. */
async function openFiledBook(entry) {
  const slot = shelfRows.remove(entry);
  if (!slot) return;
  shelfRows.arrange(settings.shelf);
  // Where it came from: the book arrives there, goes back there, and is put
  // back there if the open is given up on.
  await openFromShelf(slot.record, slot);
}

async function fileHeldBook(row) {
  const book = focused;
  if (!book) return;
  // What the shelf needs to dress a model: the library record it was opened
  // from, or what is known about whatever is open.
  const record = book.record ?? {
    id: bookState.id,
    title: bookState.title || 'Untitled',
    author: bookState.author,
    description: null,
    coverUrl: null,
    pages: content?.pageCount ?? null,
  };
  const entry = await shelfRows.file(
    row, record, community.attachments[record.id] ?? null, { hidden: true },
  );
  if (!entry) {
    setBookStatus('That shelf is full.');
    return;
  }
  // Laid out first, so the book flies to where it will actually stand rather
  // than to where the row happened to end before it joined.
  shelfRows.arrange(settings.shelf);

  // And it FLIES there, shutting on the way, the same trip a book makes going
  // back to the shelf it came off. The model it becomes is standing there
  // already, out of sight, and shows the moment the book lands on it.
  const spare = books.find((one) => one !== book) ?? null;
  const home = poseAtSlot({ ...entry, position: entry.rest, quaternion: shelfRows.upright });
  const sent = bookCarry?.returnTo(home, async () => {
    shelfRows.reveal(entry);
    focusOn(spare ?? await addBook());
    letCopyGo(book);
  });
  if (!sent) {
    // Nothing was being carried after all: it simply stands there.
    shelfRows.reveal(entry);
    focusOn(spare ?? await addBook());
    letCopyGo(book);
  }
}

// The shelves stand the way the Scene tab asks: in their order, and pushed to
// one end, the middle or the other (state/settings.js). Both the standing shelf
// and whatever has been filed on the walls.
watch(() => [settings.shelf.sort, settings.shelf.justify], () => {
  shelfBooks?.arrange(settings.shelf);
  shelfRows?.arrange(settings.shelf);
});

/**
 * The copy an open is loading into while it loads: { token, copy, focusWas }.
 *
 * An open can be abandoned after its copy exists -- Escape, or another book
 * taken down over this one -- and an abandoned open has to take its copy with
 * it. Otherwise pressing Escape on a book still converting leaves a blank one
 * lying on the desk, which is not a book anybody asked for.
 */
let loading = null;

/** Give up the copy an abandoned or failed open had made. */
function discardLoading(token) {
  if (!loading || loading.token !== token) return;
  const { copy, focusWas } = loading;
  loading = null;
  const at = books.indexOf(copy);
  // Already gone: shelved, or let go of to make room for another book. Nothing
  // to give up, and disposing a second time would free its physics twice.
  if (at < 0) return;
  books.splice(at, 1);
  // Back to the book that was in your hands before this one was started.
  if (focused === copy) {
    const back = books.includes(focusWas) ? focusWas : books[books.length - 1];
    if (back) focusOn(back);
  }
  copy.dispose();
}

focusOn(await addBook());
// Constructed BEFORE dragPageTurn on purpose: both listen for pointerdown
// in the capture phase on the same canvas, and capture-phase listeners on
// one element fire in registration order. Covers therefore get first look
// and can swallow a gesture that landed on a board before a page turn
// starts on whatever lies behind it.
const dragCover = createDragCover({ getPages, camera, renderer, controls });
const dragPageTurn = createDragPageTurn({
  getPages, camera, renderer, controls, getContent,
  onPageTurnSound: () => { console.log('onPageTurnSound fired'); audio.playPageTurn(); },
});
// Every keyboard and menu turn goes through this rather than straight to
// playTurn: a shut book has to be opened -- board, then spread -- before a
// turn has anywhere visible to go.
const bookOpening = createBookOpening({ getPages, dragCover, dragPageTurn });
const bookManipulator = createBookManipulator({
  getGroup: () => bookGroup,
  camera,
  renderer,
  getPages,
  pickBook: (event) => Boolean(focusBookUnder(event)),
  // Read through the closure: the carry is built just below.
  getCarry: () => bookCarry,
});
bookCarry = createBookCarry({
  scene,
  getGroup: () => bookGroup,
  camera,
  renderer,
  getPages,
  getPlacement: () => placement,
  // Not while a shelf model has the hand -- it is on its way to becoming
  // this very book.
  canTake: () => !shelfBooks?.held,
});
// The wall's shelves, and what is filed on them: click a row holding a book and
// the book goes there (scene/inside/shelfRows.js).
const shelfRows = createShelfRows({
  scene, camera, renderer, runs: [wallShelf, deckShelf],
});

const debugLabels = createDebugLabels({ scene, camera, renderer, getPages });

// --- the shelving, filed ----------------------------------------------------
// Every section of shelving in the room gets a call number, counting along the
// wall: the lower run, the balcony run above it, and then the standing shelf
// the books actually come off. They are labels rather than a filing system --
// nothing is shelved by them -- and they show with the ` overlay, where knowing
// which bay is which is worth something (scene/inside/callNumbers.js).
{
  let filed = 0;
  for (const run of [wallShelf, deckShelf]) {
    if (!run) continue;
    filed += numberSections(run.sections, filed);
    for (const section of run.sections) {
      debugLabels.mark(section.callNumber, section.position);
      // And each shelf within it, in its own colour: the bay says what it
      // holds, a row says where in that span you are standing.
      for (const shelf of section.shelves) {
        debugLabels.mark(shelf.callNumber, shelf.position, 'rgba(58, 74, 34, 0.86)');
      }
    }
  }
  // The standing bookshelf is one section of its own: its front face, up at the
  // top, where a run of shelving would carry its label.
  const shelfFront = new THREE.Box3().setFromObject(bookshelf);
  const standing = [{
    position: new THREE.Vector3(
      shelfFront.max.x + 0.03,
      shelfFront.max.y - 0.14,
      (shelfFront.min.z + shelfFront.max.z) / 2,
    ),
  }];
  numberSections(standing, filed);
  debugLabels.mark(standing[0].callNumber, standing[0].position);
}
const anglePanel = createAnglePanel({ getPages, getPageTurn: () => dragPageTurn });
// Outdoor lighting switches and sliders, in the same ` overlay -- outside only.
const outdoorPanel = createOutdoorPanel({ getOutside: () => outside, renderer, scene });
const fpsCounter = createFpsCounter(); // also in the ` overlay
// Which way you are looking and where you are standing -- for placing things
// in the room by eye and then writing the numbers down.
const facingPanel = createFacingPanel({ camera });
// The balcony's stair, rails, balusters, strings and posts, live -- indoors.
// Let go of a slider and the vines on it regrow to match, and the room's
// light is taken again with the new woodwork in it.
const mezzaninePanel = createMezzaninePanel({
  rebuild: () => rebuildMezzanine(),
  settle: () => {
    regrowFoliage();
    environment.refreshRoom?.();
  },
  // And the room's daylight, which the same overlay tunes.
  daylight: {
    values: ROOM_DAYLIGHT,
    apply: () => roomDaylight?.refresh(),
    settle: () => environment.refreshRoom?.(),
  },
});

// VR (WebXR): a rig carrying the camera and both controllers, and everything
// they do -- walking, turning, holding books, turning pages, the menu. Idle
// until a session starts; the button only appears where a headset can.
const vr = createVRControls({
  renderer,
  scene,
  camera,
  cameraModes,
  bookGroup,
  getPages,
  bookCarry,
  dragCover,
  dragPageTurn,
  getShelfBooks: () => shelfBooks,
  getOutside: () => outside,
});
// Out of the way while the welcome page is up (ui/LandingScreen.vue). The
// button arrives once the browser has said whether it can do VR at all.
let vrButton = null;
const placeVRButton = () => {
  if (vrButton) vrButton.style.display = landing.showing ? 'none' : '';
};
mountVRButton(vr).then((button) => {
  vrButton = button;
  placeVRButton();
});
watch(() => landing.showing, placeVRButton);
// The card on the desk tells you the headset's controls while you are wearing
// one, and the keyboard's again once you take it off.
vr.onChange((presenting) => instructionCard?.setVR(presenting));

// --- book loading ---
// HINGE_LEN/PANEL_REACH/SPINE_GAP are baked into physics bodies and
// geometry at construction, so new page dimensions mean rebuilding the
// whole simulation.
// The jacket arrives before the page dimensions do (bookLoader fires
// onJacket straight after conversion, onDimensions only once PDF.js has
// laid out page 1), and applyPdfDimensions throws the whole simulation
// away -- hardcover included -- to rebuild at the new size. So it is kept
// here and re-applied to whichever simulation is current.
let jacket = null;
// Which shelf book that jacket came off, so a shared cover it wears (the
// Community tab) dresses the real book too. Null for an uploaded file.
let jacketBookId = null;

function applyJacket() {
  if (!jacket) return;
  const design = jacketBookId ? community.attachments[jacketBookId] : null;
  const dressed = design
    ? { ...jacket, coverUrl: design.front, spineUrl: design.spine, backUrl: design.back }
    : jacket;
  pages.setJacket(dressed).catch((err) => console.error('Jacket failed to apply:', err));
}
// A cover put on or taken off while its book is out re-dresses the real book.
watch(() => community.attachments, () => { if (jacketBookId) applyJacket(); });

async function applyPdfDimensions(pageWidthPts, pageHeightPts, pageCount) {
  // The book in focus takes the loaded book's shape, and the thickness its
  // page count earns it. Its mechanism is built again at that size -- the
  // dimensions are baked into bodies and geometry when the spreads are made.
  await focused.resize(
    BASE_PANEL_REACH * (pageHeightPts / pageWidthPts), BASE_PANEL_REACH, pageCount,
  );
  pages = focused.pages;
  applyJacket();
  refreshFlipLabel();
}

// The local-PDF testing shortcut (a .pdf dropped into src/books/). Shelf
// books and uploads have their own entry points below.
initBookLoader({
  onDimensions: applyPdfDimensions,
  onPagesReady: (source) => content.setPages(source),
  onStatus: setBookStatus,
});

// --- taking a book off the shelf -----------------------------------------
// One book is readable at a time. The shelf hands over a library record, the
// loader converts and renders it, and the finished book takes the model's
// exact place in the hand -- so what you picked up and what you end up
// holding are the same object as far as the eye is concerned.
let openSequence = 0; // bumped by anything that abandons a book mid-load

// Shown in the Book tab. There is no status panel in the room any more.
function setBookStatus(text) {
  bookState.status = text;
}



/**
 * @param {object} record  the library record to open
 * @param {object|null} [slot]  the slot on the wall it was taken down from
 *   (scene/inside/shelfRows.js): the book arrives standing in it and flies into
 *   the hand from there, goes back to it when put back -- and is PUT BACK ON IT
 *   if this open is abandoned, so giving up never loses the book off the shelf.
 * @returns {Promise<boolean>} whether the book is now open -- false for one
 *   that would not convert, and for an open abandoned part way (the welcome
 *   page waits on this before taking anyone outside).
 */
async function openFromShelf(record, slot = null) {
  const token = (openSequence += 1);
  // Whether the slot has been handed to the book that arrived. Until it has,
  // this open owes the shelf a book.
  let slotTaken = false;
  // Chapters come off the shelf with the book: the library listing already
  // carries them, so the Book tab is populated the moment you pick it up
  // rather than when the last page finishes rasterizing.
  bookState.id = record.id;
  bookState.title = record.title;
  bookState.author = record.author;
  bookState.chapters = Array.isArray(record.chapters) ? record.chapters : [];
  bookState.loading = true;
  try {
    await openLibraryBook(record.id, {
      // Only while this is the book being opened: its pages go on rendering
      // after the open returns, and a book opened since has its own to report.
      onStatus: (text) => { if (token === openSequence) setBookStatus(text); },
      onJacket: (j) => {
        if (token !== openSequence) return;
        jacket = j;
        jacketBookId = record.id;
        applyJacket();
      },
      onChapters: (chapters) => {
        if (token !== openSequence) return;
        bookState.chapters = chapters;
      },
      onDimensions: async (widthPts, heightPts, pageCount) => {
        if (token !== openSequence) return;
        // A copy of its own, taken the moment its shape is known: the book you
        // were reading stays readable until this one is ready to take its place
        // in your hands, and then stays in the room rather than being reused.
        // Held on to while it loads, so that giving up on this book gives up
        // the copy with it (discardLoading).
        const focusWas = focused;
        loading = { token, copy: await takeFreshCopy(), focusWas };
        // Which book this copy IS, for whenever it is filed on a shelf.
        loading.copy.record = record;
        if (token !== openSequence) {
          discardLoading(token);
          return;
        }
        await applyPdfDimensions(widthPts, heightPts, pageCount);
        if (token !== openSequence) discardLoading(token);
      },
      // As soon as the book's shape is known, not once its pages are drawn:
      // they fill in while it is already in your hand (loader/bookLoader.js's
      // openPdfPages).
      onPagesReady: (source) => {
        if (token !== openSequence) {
          source.cancel(); // put back while it was opening: no pages wanted
          return;
        }
        // It has arrived: from here it is one of the room's books, and giving
        // up on it later is no longer this open's business.
        loading = null;
        content.setPages(source);
        if (slot) {
          slotTaken = true;
          // Standing in its slot, and into your hand from there -- and back to
          // that same slot, as a model again, if it is put back.
          const home = poseAtSlot(slot);
          bookGroup.position.copy(home.position);
          bookGroup.quaternion.copy(home.quaternion);
          placement.reset(home.position, home.quaternion);
          bookCarry.takeFrom(home, async (arrived) => {
            if (!arrived) return;
            const back = focused;
            await shelfRows.file(
              slot.row, slot.record, community.attachments[slot.record?.id] ?? null,
            );
            shelfRows.arrange(settings.shelf);
            const spare = books.find((one) => one !== back) ?? null;
            focusOn(spare ?? await addBook());
            letCopyGo(back);
          });
        } else swapModelForBook();
      },
    });
    return token === openSequence;
  } catch (err) {
    console.error('Opening a shelf book failed:', err);
    setBookStatus(`Error: ${err.message}`);
    return false;
  } finally {
    // Abandoned, or failed part way: the copy this open made goes too. Nothing
    // to do when it arrived -- onPagesReady let go of it.
    discardLoading(token);
    // And the shelf gets its book back. Taking one down removes its model, so
    // an open that never finished would otherwise lose the book from both the
    // shelf and the room.
    if (slot && !slotTaken) {
      await shelfRows.file(slot.row, slot.record, community.attachments[slot.record?.id] ?? null);
      shelfRows.arrange(settings.shelf);
    }
    if (token === openSequence) bookState.loading = false;
  }
}

/**
 * Open an EPUB the reader picked from their own computer (the Book tab's
 * "Choose EPUB…"). It lands on the desk rather than in the hand: there is
 * no shelf model for it to take the place of.
 *
 * Guarded by openSequence exactly as a shelf book is, so picking something
 * off the shelf mid-upload abandons the upload, and the other way round.
 *
 * @returns {Promise<boolean>} whether the book is now open. False covers
 *   both a file that would not convert and an open that was abandoned part
 *   way -- in neither case is there a book to go outside with.
 */
async function openUploadedFile(file) {
  // Whatever is in hand goes back first. Putting a shelf model back bumps
  // openSequence on its own (populateShelf's onTake), abandoning its load;
  // a book being carried goes home, to the desk or into the shelf.
  shelfBooks?.release();
  bookCarry?.putBack();
  const token = (openSequence += 1);
  const current = () => token === openSequence;

  bookState.id = null;
  bookState.title = file.name.replace(/\.epub$/i, '');
  bookState.author = null;
  bookState.chapters = [];
  bookState.loading = true;
  try {
    await uploadBook(file, {
      onStatus: (text) => { if (current()) setBookStatus(text); },
      onJacket: (j) => {
        if (!current()) return;
        jacket = j;
        jacketBookId = null;
        applyJacket();
        if (j.title) bookState.title = j.title;
        bookState.author = j.author;
      },
      onChapters: (chapters) => {
        if (current()) bookState.chapters = chapters;
      },
      // An upload is one of the shelf's books now (loader/bookLoader.js): it
      // goes onto the shelf where it will be next time, and into the reader's
      // own library if they are signed in. Neither is worth failing the open
      // over -- the book they just uploaded is in front of them either way.
      onShelved: async (entry) => {
        if (!current() || !entry) return;
        bookState.id = entry.id;
        jacketBookId = entry.id;
        try {
          const size = await shelfBooks?.add(entry);
          await rememberBook({ ...entry, size });
        } catch (err) {
          console.error('The uploaded book could not be added to the library:', err);
        }
      },
      onDimensions: async (widthPts, heightPts, pageCount) => {
        if (!current()) return;
        await applyPdfDimensions(widthPts, heightPts, pageCount);
      },
      onPagesReady: (source) => {
        if (current()) content.setPages(source);
        else source.cancel();
      },
    });
    return current();
  } catch (err) {
    console.error('Opening an uploaded book failed:', err);
    if (current()) setBookStatus(`Error: ${err.message}`);
    return false;
  } finally {
    if (current()) bookState.loading = false;
  }
}

/**
 * How the welcome page ends, whichever book was chosen there
 * (ui/LandingScreen.vue): out of the door with it in your hand.
 *
 * The book goes INTO THE HAND before the door opens, because the hand is
 * what decides: outdoors draws the books it has been told are out there, and
 * the one you are holding is always one of them (scene/outside/outside.js's
 * followBook). Handed over the other way round it would be a book left
 * behind on a desk nobody can see.
 *
 * The welcome stays up until the book is open, so one that will not convert
 * leaves the visitor where they were, with the reason on the page, rather
 * than alone outside with nothing to read.
 *
 * @param {() => Promise<boolean>} open  whatever opens the book
 */
async function startOutsideWith(open) {
  landing.error = '';
  if (!await open()) {
    landing.error = bookState.status || 'That book could not be opened.';
    setBookStatus('');
    return;
  }
  landing.showing = false;
  bookCarry?.takeUp();
  await outside?.goOutside();
  recommendHeadphones();
}

/** An EPUB the visitor brought from their own computer. */
const startWithBook = (file) => startOutsideWith(() => openUploadedFile(file));

/**
 * Or one already on the shelf, for someone who has not got an EPUB to hand
 * and wants to see what this is. Opened by exactly the path the shelf itself
 * uses -- converted once and cached under its library id, so the example
 * everybody tries is converted for the first visitor and free after that.
 */
const startWithExample = (record) => startOutsideWith(() => openFromShelf(record));

// Which way a book comes off the shelf shut -- see PageSimulation.close.
// 'front' is shut the ordinary way: cover up, and the first arrow press opens
// the front board onto page one.
const SHUT_ON = 'front';

/**
 * Replace the model in hand with the real book, in the same place and at
 * the same size -- and from there on, carry it like a book taken off the
 * desk (input/bookCarry.js): it settles into the reading pose, can be slid,
 * turned, pushed and squared up, and its home is the model's slot, so
 * putting it back flies it into the shelf.
 *
 * SHUT. The model is a shut book, so the real one arrives shut too, and is
 * placed by the middle of its page block, which is where the model's own
 * origin is -- not by bookGroup's origin, which is the spine of the book
 * lying open. It stays shut in the hand under the carried gravity.
 *
 * SCALE. The book is scaled so its pages are exactly as tall as the model's
 * were. The shelf models are built to the same binding proportions as the
 * readable book (bookModel.js takes its ratios from hardcover.js), so
 * matching that one dimension is enough for the two to read as the same
 * object and for the swap to disappear. That scale then stays: it is a
 * render-only group scale, the page simulation runs in its own units
 * regardless, and the placement colliders are sized from the group -- so a
 * short fat book really is shorter and fatter on the desk afterwards.
 */
function swapModelForBook() {
  const size = shelfBooks?.heldSize;
  if (!size) return;
  // A book still on its way home gives way first -- before the new one is
  // posed, since letting go of a shelf book shows its model again.
  bookCarry.letGo();
  const shut = pages.close(SHUT_ON);
  const scale = size.length / HINGE_LEN;
  bookGroup.scale.setScalar(scale);
  // In VR the model is in a hand, and the book it becomes stays in it.
  const hand = shelfBooks.heldHand;
  const home = shelfBooks.handOver(bookGroup, {
    position: shut.centre.multiplyScalar(scale),
    quaternion: shut.quaternion,
  });
  if (!home) return;
  bookCarry.takeFrom(home, (arrived) => {
    // Flown back into its own slot: the shelf takes its copy back, and the real
    // book goes to the desk. Let go of ANYWHERE ELSE -- dropped, or dropped
    // because another book was picked up -- and it has left the shelf: it is
    // out in the room now (book/bookInstance.js), and the gap it left stays a
    // gap rather than the shelf quietly growing a second copy of it.
    if (!arrived) return;
    home.takeBack();
    stowBook();
  });
  if (hand) bookCarry.holdIn(hand);
}

/** The real book has flown back into the shelf. */
function stowBook() {
  // bookGroup was just posed inside the shelf, where the model has this
  // instant reappeared. Moving it here as well as in the body keeps the two
  // from sharing a slot for the one frame before placement drives it again.
  bookGroup.position.copy(RESET_POSITION);
  bookGroup.quaternion.copy(RESET_QUATERNION);
  placement.reset(RESET_POSITION, RESET_QUATERNION);
}

/**
 * Set the held book down where it was clicked, if that was the desk --
 * square, whichever way it was lying before. Off the shelf or off the desk,
 * it just comes out of the hand (a shelf book's model reappears in its slot
 * as it does) and drops the last couple of centimetres under its own weight.
 */
const _placeRay = new THREE.Raycaster();
const _placePosition = new THREE.Vector3();

function putBookDown(event) {
  if (!bookCarry?.held) return;
  aimAtPointer(_placeRay, event.clientX, event.clientY, camera, renderer.domElement);
  const hit = _placeRay.intersectObject(desk.object, true)[0];
  if (!hit) return; // only the desk will take a book

  bookCarry.letGo();
  _placePosition.copy(hit.point).setY(hit.point.y + 0.02);
  bookGroup.position.copy(_placePosition);
  bookGroup.quaternion.copy(RESET_QUATERNION);
  placement.reset(_placePosition, RESET_QUATERNION);
}

// --- UI ---
const flipBtn = document.getElementById('flipBtn');
const resetBtn = document.getElementById('resetBtn');
let simulationPaused = false;

function refreshFlipLabel() {
  if (flipBtn) flipBtn.textContent = pages.flipped ? 'Flip book back' : 'Flip book over';
}

const RESET_POSITION = new THREE.Vector3(0, 0.02, 0);
const RESET_QUATERNION = new THREE.Quaternion();

function resetBook() {
  bookCarry.letGo(); // out of the hand, or the hand would carry it straight back off
  pages.reset();
  bookGroup.quaternion.copy(RESET_QUATERNION);
  bookGroup.position.copy(RESET_POSITION); // also undo any shift-drag repositioning
  // The body holds the real placement state -- putting bookGroup back
  // without this would be undone by the next step().
  placement.reset(RESET_POSITION, RESET_QUATERNION);
  refreshFlipLabel();
}

/**
 * Coming back in off the hillside: anything left lying out there comes home
 * to the desk.
 *
 * A book put down outside keeps its place in world coordinates -- a hundred
 * metres of terrain away from a room that is about to be drawn again, with
 * every book in it visible once more (scene/outside/outside.js's showInside).
 * Left alone it would hang in the air past the wall, out over ground that is
 * no longer there. It could as easily be walked back to and picked up, but
 * the door is not where you dropped it, and a book you have to go outside
 * again to retrieve is a book you have lost.
 *
 * The one in your hands is not fetched: it came in with you.
 */
watch(() => world.place, (place, before) => {
  if (place !== 'room' || before !== 'outside') return;
  for (const one of leftOutside) {
    if (one === focused && bookCarry?.carrying) continue;
    one.group.position.copy(RESET_POSITION);
    one.group.quaternion.copy(RESET_QUATERNION);
    one.placement?.reset(RESET_POSITION, RESET_QUATERNION);
  }
  leftOutside.clear();
});

flipBtn?.addEventListener('click', () => { pages.toggleFlip(); refreshFlipLabel(); });
resetBtn?.addEventListener('click', resetBook);
refreshFlipLabel();

window.addEventListener('keydown', (e) => {
  if (matches('debug.pause', e) && anglePanel.visible && world.place === 'room') {
    simulationPaused = !simulationPaused;
    e.preventDefault();
    return;
  }
  if (matches('book.reset', e)) {
    // In the hand it means "square it up again", not "put it on the desk".
    if (bookCarry.held) bookCarry.straighten();
    else resetBook();
  }
  // Let go of the book right where it is held: the hand opens and it falls,
  // keeping however the hand was moving, onto whatever is under it -- the
  // desk or the floor in the room, the hillside outside, where a patch of
  // ground follows the book about for exactly this
  // (book/placement/bookPlacement.js). A shelf model still waiting for its
  // pages has nothing to fall with yet, so it just goes back to its slot.
  if (matches('book.drop', e) && !e.repeat) {
    if (bookCarry.held) {
      bookCarry.letGo();
      // Out here it is now scenery, not something in your hands, and the
      // outdoors draws only what it has been told is out here.
      if (outdoorGround && focused) leftOutside.add(focused);
    } else if (shelfBooks?.held) {
      shelfBooks.release();
    }
  }
  // A setting rather than a flag of its own, so Settings shows the same
  // state and the choice is remembered. See bindSettings' bindRoom.
  if (matches('room.walls', e) && !e.repeat) settings.graphics.walls = !settings.graphics.walls;
  if (matches('book.flip', e)) { pages.toggleFlip(); refreshFlipLabel(); }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    return;
  }
  // Arrow keys play the same physical turn a drag does rather than swapping
  // textures underneath you -- playTurn runs dragPageTurn's own animation
  // and commits through content.commitTurn at the end, so page content, the
  // leaf's two faces and the hinge position all move together exactly as
  // they do for a mouse turn. Forward is the right-hand page, same as
  // dragging it. A shut book spends the first presses opening instead.
  if (matches('book.pageForward', e)) bookOpening.turn(RIGHT_HAND_PANEL);
  if (matches('book.pageBack', e)) bookOpening.turn(LEFT_HAND_PANEL);
});

// --- the menu -------------------------------------------------------------
// The tabs get a small set of verbs, not the scene. Everything else they
// need is in the stores (state/), which this file keeps up to date.
mountMenu({
  goToPage: (page) => content.goToPage(page),
  turnPage: (direction) => bookOpening.turn(
    direction > 0 ? RIGHT_HAND_PANEL : LEFT_HAND_PANEL,
  ),
  setBackground: (id) => scenery.setBackground(id),
  uploadBook: (file) => openUploadedFile(file),
  // The Scene tab's room / outside switch (scene/outside/outside.js).
  goOutside: () => outside?.goOutside(),
  goInside: () => outside?.goInside(),
  // And its shelf: every book in the room back where it came from.
  shelveBooks,

  // Escape, innermost meaning first: a book in the hand goes back before
  // the menu will open. Returning true means the press was spent.
  escape: () => {
    // The book controls, laid over the whole screen, go first of all.
    if (bookControls.showing) {
      bookControls.showing = false;
      return true;
    }
    // The card held up in front of you goes back before a book in your hand.
    if (instructionCard?.held) {
      instructionCard.release();
      return true;
    }
    if (bookCarry?.held) {
      bookCarry.putBack();
      return true;
    }
    if (!shelfBooks?.held) return false;
    shelfBooks.release();
    return true;
  },
});

// The welcome page, for a visitor who is not signed in. Mounted every visit
// and showing nothing until the startup below says so, so there is no second
// load between the loading screen lifting and the welcome appearing.
mountLanding({ startWithBook, startWithExample });

// The account control, top right. Independent of the menu and of the room.
mountAccount({
  // The books button outside: a book off the shelf into your hand -- or, if
  // it is the book already out, lying on the desk, that one up into it.
  takeBook: (id) => {
    if (shelfBooks?.take(id)) return;
    if (bookState.id === id) bookCarry?.takeUp();
  },
});
// Settings and key bindings follow the account while someone is signed in.
startPreferencesSync();

// --- render loop ---
let lastFrameTime = performance.now();
renderer.setAnimationLoop(() => {
  if (markFirstFrame) {
    markFirstFrame();
    markFirstFrame = null;
  }
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 1 / 30);
  lastFrameTime = now;

  // The debug overlay (the ` key) is the ROOM's: the call numbers on its
  // shelves, the book-on-the-desk's hinge readouts, where you are facing in
  // it. Outside, none of it shows, whatever the key was left at -- only the
  // outdoor panel, which is the outdoors' own, and the frame rate, which
  // belongs to wherever you are.
  // And none of it, anywhere, while the welcome page is up: that page is the
  // only thing on screen until a visitor has chosen a way in.
  const debugShown = !landing.showing;
  const indoors = world.place === 'room';
  const roomDebug = anglePanel.visible && indoors && debugShown;
  // Nor does a debug pause outlast leaving the room: out of doors there is
  // nothing to unpause it with.
  if (!roomDebug) simulationPaused = false;

  // In VR the headset and the controllers move you (input/vrControls.js); the
  // desktop rig would only fight them for the camera. First, so everything
  // posed from a hand or the head below sees where they are this frame.
  if (renderer.xr.isPresenting) vr.update(dt);
  else cameraModes.update(dt);
  // Carried -- up off the desk, or a shelf book in hand -- the pages feel down
  // as though the book were lying flat. See bookManipulator.update.
  const carried = bookCarry.carrying;
  bookManipulator.update({ carried });

  // Mirror the reading position for the Book tab. Assigned only on a real
  // change: writing the same value every frame would wake every watcher
  // sixty times a second for nothing.
  if (bookState.page !== content.page) bookState.page = content.page;
  if (bookState.pageCount !== content.pageCount) bookState.pageCount = content.pageCount;
  // How far the book in focus has got drawing its pages, for the progress
  // bar (ui/RenderProgress.vue) -- read off the book itself, so it is always
  // the one in your hands whatever was opened, put back or swapped since.
  if (bookState.pagesRendered !== content.pagesRendered) bookState.pagesRendered = content.pagesRendered;
  if (bookState.pagesTotal !== content.pageCount) bookState.pagesTotal = content.pageCount;
  if (!simulationPaused) {
    content.update(dt);
    // Before the step: the holds it sets are applied inside step().
    bookOpening.update(dt);
    pages.step();
    // After pages.step(), so the cover colliders are posed from the H1/H2
    // this frame actually rendered rather than last frame's.
    // A book in hand is carried: the placement body goes kinematic and
    // follows the pose the shelf is writing onto bookGroup, so setting it
    // down lands it on the desk like anything else.
    placement.step(dt, bookManipulator.grabbed || carried);
    dragPageTurn.update(dt);
    // What that step did to the book in focus, kept: the spine leans a little
    // further every step (config.js's setSpineRotation), and it is the MODULE
    // bindings it leans in. Stepping another book below installs that book's
    // numbers and puts these back afterwards -- so without reading them back
    // first, every frame would hand the book in your hands the lean it had
    // when it was picked up, and the spine would never move at all.
    captureBookConfig(focused.config);
    // And the books nobody is holding: each settles, falls and lands on its
    // own, with its own dimensions in force for the step (bookInstance.js).
    // Outside, only those out there too: the rest are lying in a room that is
    // not being drawn, and each is a whole page simulation and a physics world
    // stepped every frame for nobody. They pick up where they were when you
    // come back in -- the steps clamp their own interval, so the time away is
    // not delivered all at once.
    for (const book of books) {
      if (book !== focused && (indoors || leftOutside.has(book))) book.stepParked(dt);
    }
  }
  // OrbitControls poses the camera on every update() -- enabled or not --
  // so the modes that steer it directly must not let it run.
  if (cameraModes.mode === CAMERA_MODE.ORBIT && !renderer.xr.isPresenting) controls.update();
  // After the camera has finished moving for the frame: a book in hand is
  // posed from it, and stepping first would leave it a frame behind.
  shelfBooks?.update(dt);
  shelfRows.update(dt); // the books filed on the walls draw out under the cursor too
  bookCarry.update(dt); // posed from the camera too
  instructionCard?.update(dt); // also posed from the camera, so also after it has moved
  // Outside draws through its own fog and exposure chain (scene/outside/outdoorPost.js);
  // the room through its sunbeams, when the sun is in it (scene/inside/roomBeams.js).
  roomDust?.update(dt, renderer, camera);
  if (!outside?.render(dt)) {
    if (roomBeams) roomBeams.render(dt);
    else renderer.render(scene, camera);
  }
  debugLabels.update(indoors && debugShown);
  anglePanel.update(indoors && debugShown);
  outdoorPanel.update(anglePanel.visible && debugShown);
  fpsCounter.update(anglePanel.visible && debugShown);
  facingPanel.update(roomDebug);
  mezzaninePanel.update(roomDebug);
});

if (import.meta.env.DEV) {
  // THREE is included so console debugging can build THREE.Box3 etc.
  // against these objects without a separate import.
  window.__athenaeum = {
    scene, camera, controls, cameraModes, renderer, dragPageTurn, dragCover, anglePanel, THREE,
    // The books in the room, and another copy on demand -- several can be out
    // at once (book/bookInstance.js). Getters, not values: the one in focus
    // changes as books are picked up.
    books,
    addBook,
    focusOn,
    get focused() { return focused; },
    get pages() { return pages; },
    get content() { return content; },
    get bookGroup() { return bookGroup; },
  };
}