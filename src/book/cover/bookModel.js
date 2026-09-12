import * as THREE from 'three';
import { createBoardGeometry, BOARD_FACE_PY, BOARD_FACE_NY } from './boardGeometry.js';
import {
  SQUARE_RATIO, BOARD_THICKNESS_RATIO, PAGE_CLEARANCE_RATIO,
  GROOVE_WIDTH_RATIO, GROOVE_MAX_SPINE_FRACTION, GROOVE_THICKNESS_RATIO,
  EDGE_FILLET_RATIO, BOARD_COLOR, SPINE_COLOR,
} from './hardcover.js';
import {
  sampleBindingColor, renderSpineLabel, renderBackPanel, toHex, shade,
} from './jacketArt.js';

/**
 * A closed book, as scenery.
 *
 * Same binding as the readable book -- eased boards, a flat back, a groove
 * each side of the spine -- but static: no pages, no hinges, no physics.
 * For filling a shelf, where a book is a silhouette and a spine you read
 * from across the room.
 *
 * The proportions come from hardcover.js rather than being restated here,
 * so a shelf of these and the book on the desk are recognisably the same
 * binding. Only the SIZE is free.
 *
 * LOCAL FRAME. Matches hardcover.js, so the two can be reasoned about
 * together:
 *
 *     +X   along the spine -- the book's `length` (its height, shelved)
 *     +Y   through the boards -- its `thickness`
 *     +Z   spine to fore-edge -- its `width`
 *
 * Centred on its own middle, spine at -Z. To stand one on a shelf, rotate
 * -90 degrees about Z (which puts the length up) and it will be sitting on
 * its tail with the spine facing -Z.
 */

// Boards are card; paper is not. A hair of sheen separates them.
const PAPER_COLOR = 0xe6dcc4;

/**
 * @param {object} opts
 * @param {number} opts.length     spine length -- the tall dimension
 * @param {number} opts.width      spine to fore-edge
 * @param {number} opts.thickness  overall, board face to board face
 *
 * @param {string|null} [opts.title]   used by the auto-generated art
 * @param {string|null} [opts.author]
 * @param {string|null} [opts.blurb]   back panel only
 *
 * Art. Each of these takes an image URL; leave it null and that face is
 * generated from the title/author and the binding colour instead.
 * @param {string|null} [opts.coverImage]  front board
 * @param {string|null} [opts.spineImage]  spine
 * @param {string|null} [opts.backImage]   back board
 *
 * Each image the way it is SEEN: the front and back boards as they face
 * you, and the spine standing up, head at the top, as on a shelf -- which is
 * how shared covers are made (community/covers.js). They are turned onto
 * the faces here.
 *
 * @param {boolean} [opts.spineTextTowardTail]  which way the spine reads
 * @param {number|null} [opts.bindingColor]  overrides the colour otherwise
 *   sampled from the cover art
 */
export async function createBookModel({
  length, width, thickness,
  title = null, author = null, blurb = null,
  coverImage = null, spineImage = null, backImage = null,
  spineTextTowardTail = false,
  bindingColor = null,
}) {
  // --- proportions -------------------------------------------------------
  // Everything is a fraction of `width` for the same reason hardcover.js
  // works off PANEL_REACH: it is the dimension a binding's details scale
  // with. The groove is additionally capped against the book's own
  // thickness, since a slim book has very little spine to give away.
  const square = width * SQUARE_RATIO;
  const board = width * BOARD_THICKNESS_RATIO;
  const clearance = width * PAGE_CLEARANCE_RATIO;
  const half = thickness / 2;
  const groove = Math.min(width * GROOVE_WIDTH_RATIO, half * GROOVE_MAX_SPINE_FRACTION);

  const group = new THREE.Group();
  group.name = 'bookModel';

  // --- art ---------------------------------------------------------------
  const loader = new THREE.TextureLoader();
  const owned = []; // textures and materials to dispose with the model

  async function loadTexture(url) {
    const texture = await loader.loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    owned.push(texture);
    return texture;
  }

  const coverTexture = coverImage ? await loadTexture(coverImage) : null;

  // The board's cap uv runs u along +X -- which is the SPINE, the tall
  // dimension once the book is stood on a shelf. So cover art arrives lying
  // on its side. Quarter turn to stand it up.
  //
  // Sampling coordinates rotate by -rotation, so the image turns by
  // +rotation in uv space; and looking at the front board from outside, v
  // points down the page, which makes a positive angle read clockwise.
  if (coverTexture) {
    coverTexture.center.set(0.5, 0.5);
    coverTexture.rotation = Math.PI * -1 / 2;
  }

  // The binding colour ties the whole object together: sampled from the
  // cover's own border when there is art to sample, so a generated spine
  // and back look like they belong to the same jacket.
  let binding = { r: 74, g: 47, b: 36 }; // BOARD_COLOR
  if (bindingColor != null) {
    binding = {
      r: (bindingColor >> 16) & 0xff,
      g: (bindingColor >> 8) & 0xff,
      b: bindingColor & 0xff,
    };
  } else if (coverTexture?.image) {
    binding = sampleBindingColor(coverTexture.image);
  }

  function canvasTexture(canvas) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    owned.push(texture);
    return texture;
  }

  // Label canvases are sized to their own panel's proportions so the type
  // is not stretched when it lands on a long thin spine or a squat board.
  const spineTexture = spineImage
    ? await loadTexture(spineImage)
    : canvasTexture(renderSpineLabel({
      title, author, background: binding,
      lengthPx: 1024,
      widthPx: Math.max(24, Math.round((1024 * thickness) / length)),
    }));

  const backTexture = backImage
    ? await loadTexture(backImage)
    : canvasTexture(renderBackPanel({
      title, author, blurb, background: binding,
      widthPx: 512,
      heightPx: Math.max(64, Math.round((512 * length) / width)),
    }));

  // A spine image stands up, head at the top, but the spine face's u runs
  // along the length from the head (-X) and its v through the boards toward
  // the front one (+Y): a quarter turn puts the image's top at the head and
  // its right-hand edge against the front board, as on a jacket laid flat.
  if (spineImage) {
    spineTexture.center.set(0.5, 0.5);
    spineTexture.rotation = Math.PI / 2;
  } else if (spineTextTowardTail) {
    // English spines read top-to-bottom shelved, which is the opposite way
    // round from how the canvas lands on the board. Flipping u is cheaper
    // than re-rendering the label mirrored.
    spineTexture.center.set(0.5, 0.5);
    spineTexture.repeat.set(-1, 1);
  }

  // A back image stands up like the front and takes the same quarter turn:
  // the back board's v runs the other way across it, which is exactly what
  // looking at it from the other side needs.
  if (backImage) {
    backTexture.center.set(0.5, 0.5);
    backTexture.rotation = Math.PI * -1 / 2;
  }

  // --- materials ---------------------------------------------------------
  function material(options) {
    const m = new THREE.MeshStandardMaterial(options);
    owned.push(m);
    return m;
  }

  const bindingMaterial = material({
    color: toHex(binding), roughness: 0.72, metalness: 0.04,
  });
  const frontMaterial = material({
    color: coverTexture ? 0xffffff : toHex(binding),
    map: coverTexture, roughness: 0.6, metalness: 0.03,
  });
  const backMaterial = material({
    color: 0xffffff, map: backTexture, roughness: 0.6, metalness: 0.03,
  });
  const spineMaterial = material({
    color: 0xffffff, map: spineTexture, roughness: 0.78, metalness: 0.04,
  });
  const spineSideMaterial = material({
    color: toHex(shade(binding, 0.92)), roughness: 0.78, metalness: 0.04,
  });
  const paperMaterial = material({
    color: PAPER_COLOR, roughness: 0.95, metalness: 0,
  });

  // --- boards ------------------------------------------------------------
  // Grown by the square on the head, tail and fore-edge, but NOT at the
  // spine: that edge has to stay on the hinge line or the joint would not
  // line up with the spine slab.
  function makeBoard(outSign, faceMaterial, faceIndex) {
    const geometry = createBoardGeometry({
      width: length + 2 * square,
      depth: width + square,
      thickness: board,
      cornerRadius: 0, // sharp corners; the edge fillets mitre into each other
      edgeRadius: board * EDGE_FILLET_RATIO,
    });
    // Z: shift the whole square to the fore-edge so the hinge edge lands on
    // -width/2. Y: outer face flush with the book's overall thickness.
    geometry.translate(0, outSign * (half - board / 2), square / 2);

    const materials = [bindingMaterial, bindingMaterial, bindingMaterial];
    materials[faceIndex] = faceMaterial;

    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = outSign > 0 ? 'frontBoard' : 'backBoard';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
  group.add(makeBoard(+1, frontMaterial, BOARD_FACE_PY));
  group.add(makeBoard(-1, backMaterial, BOARD_FACE_NY));

  // --- spine -------------------------------------------------------------
  // Three boxes, not a swept strip: on a static model the flat back and its
  // two grooves are axis-aligned slabs, and the readable book only sweeps
  // its spine because the covers move underneath it.
  //
  // All three share an inner face on the hinge plane, so the grooves --
  // being shallower -- are recessed on the OUTSIDE, which is where the
  // joint's shadow line belongs.
  const spineFace = -width / 2;
  const grooveDepth = board * GROOVE_THICKNESS_RATIO;

  function makeSpinePiece(spanY, centreY, depth, materials, name) {
    const geometry = new THREE.BoxGeometry(length + 2 * square, spanY, depth);
    geometry.translate(0, centreY, spineFace - depth / 2);
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  // BoxGeometry's face order is px, nx, py, ny, pz, nz -- so index 5 is the
  // outward-facing -Z face, the one the label goes on.
  const slabMaterials = Array(6).fill(spineSideMaterial);
  slabMaterials[5] = spineMaterial;
  makeSpinePiece(Math.max(1e-6, thickness - 2 * groove), 0, board, slabMaterials, 'spine');

  for (const sign of [1, -1]) {
    makeSpinePiece(
      groove,
      sign * (half - groove / 2),
      grooveDepth,
      spineSideMaterial,
      sign > 0 ? 'grooveFront' : 'grooveBack',
    );
  }

  // --- page block --------------------------------------------------------
  // What you actually see of it is the fore-edge and the head and tail, so
  // it is just a box: inset from the boards by the square, and thin enough
  // to sit between their inner faces with the same clearance the readable
  // book leaves.
  const blockGeometry = new THREE.BoxGeometry(
    length,
    Math.max(1e-6, thickness - 2 * (board + clearance)),
    width,
  );
  const block = new THREE.Mesh(blockGeometry, paperMaterial);
  block.name = 'pageBlock';
  block.castShadow = true;
  block.receiveShadow = true;
  group.add(block);

  return {
    group,
    binding,
    dispose() {
      for (const child of group.children) child.geometry.dispose();
      for (const resource of owned) resource.dispose();
      group.clear();
    },
  };
}
