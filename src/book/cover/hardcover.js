import * as THREE from 'three';
import { HINGE_LEN, PANEL_REACH, PIVOT_TO_NEAR_EDGE, SPINE_GAP } from '../pageSim/config.js';
import { pageTransform, spineHinge } from '../pageSim/math.js';
import { sampleBindingColor, renderSpineLabel, toHex, shade, luminance } from './jacketArt.js';
import { createBoardGeometry, BOARD_FACE_PY, BOARD_FACE_NY } from './boardGeometry.js';
import { twoSidedShadows } from '../../scene/twoSidedShadows.js';

/**
 * The book's hardcover: two render-only boards with their own H1/H2 angles,
 * plus a spine that bridges them.
 *
 * GEOMETRY. Everything is built in a cover page's own local frame, which
 * spread.js's panelGeo establishes as:
 *
 *     +X  along the spine        (page height, half-extent HINGE_LEN/2)
 *     +Z  hinge -> fore-edge     (page width, hinge at -PANEL_REACH/2)
 *     +Y  the page's normal
 *
 * A board is that frame grown by SQUARE on three sides -- the fore-edge
 * and both head/tail edges -- but NOT at the hinge, which has to stay
 * exactly on the hinge line or the cover would not pivot with its page.
 * That overhang is what bookbinders call the "square"; it is the whole
 * reason a hardcover reads as a hardcover rather than a stiff page.
 *
 * WHICH SIDE IS OUTSIDE. A board sits on the face pointing
 * away from the page block. In the page's local frame that is a constant
 * (+Y for the front board, -Y for the back), which is what lets the board
 * simply copy its page's transform. To see why: the four panels only sit
 * face-to-face when the book is cslosed, which is the pose where every
 * page angle is BC_MEET_ANGLE (pi/2), and there a page's local +Y maps to
 * world +Z -- the same axis the panels are stacked along, with A at the
 * +Z end of the stack and D at the -Z end. So +Y points out of the stack
 * for A and into it for D. Being rigidly attached, that holds in every
 * other pose too: open flat (A at 0, D at pi) both boards end up on the
 * underside, which is exactly where a real book's covers lie against the
 * table.
 *
 * The boards are render-only: they add no rigid bodies or constraints and
 * do not read A, D, P1, or P2. Their angles are supplied independently by
 * PageSimulation and remain where the user leaves them.
 */

// All proportional to the page so a re-sized book (a loaded PDF changes
// HINGE_LEN/PANEL_REACH/SPINE_GAP) keeps the same cover proportions.
export const SQUARE_RATIO = 0.025; // overhang past the page, as a fraction of PANEL_REACH
const BACK_EDGE_EXTENSION_RATIO = 0.015; // extra material behind the hinge toward the spine
export const BOARD_THICKNESS_RATIO = 0.015; // board thickness, likewise
// Gap between the page surface and the board's inner face. Only big enough
// to keep the two from being coincident: a shut book should look shut, and
// anything larger reads as the cover hovering off the block.
export const PAGE_CLEARANCE_RATIO = 0.001;

// The spine's cross-section is six rows: a thin strip, a hard step up, the
// full-thickness slab, a step back down, and the far thin strip. Nothing
// between those is curved, so there is nothing to subdivide -- but the two
// steps need a DUPLICATED row each (same position, two thicknesses) or the
// mesh would ramp between them instead of stepping.
//
//   row 0   board edge          thin
//   row 1   slab starts here    thin   |
//   row 2   same position       full   |  the step
//   row 3   slab ends           full
//   row 4   same position       thin   |  the step
//   row 5   board edge          thin   |
const SPINE_SEGMENTS = 5;

// Thickness of the groove strip, as a fraction of the board's.
export const GROOVE_THICKNESS_RATIO = 0.35;

/**
 * The joint -- what bookbinders call a French groove: the channel running
 * down each side of the spine, and the line the board actually swings on.
 *
 * It is not a notch cut into the board, and it is NOT the board standing
 * off the block either -- that was tried and it is wrong: a cased board
 * lies flat against the block when the book is shut, and pushing it out by
 * the joint leaves a permanent gap you can see down.
 *
 * Instead the spine's own slab stops this far short of the block's edge,
 * and the remaining strip out to the board is carried by a THINNER, flat
 * extension -- the covering material spanning the channel. So the spine
 * still reaches the board and the cover is continuous; it just steps down
 * to a thinner section on the way, and that recess is the joint's shadow
 * line.
 *
 * The board is untouched and stays flush, and its hinge edge is the
 * groove's outer wall -- the line a real cover swings on.
 *
 * A fraction of PANEL_REACH like every other cover proportion, but capped
 * against SPINE_GAP: a thin book has very little spine to give away.
 */
export const GROOVE_WIDTH_RATIO = 0.012;
export const GROOVE_MAX_SPINE_FRACTION = 0.25;

export const BOARD_COLOR = 0x4a2f24; // plain binding, until a jacket is applied
export const SPINE_COLOR = 0x3d2620;

// BoxGeometry emits its six faces in this order, so the outward face of
// a board -- local +Y on the front, -Y on the back -- is the group that
// takes the cover art.
const FACE_PY = BOARD_FACE_PY;
const FACE_NY = BOARD_FACE_NY;

// A shared cover's spine image stands up, head at the top, the way a spine
// is seen shelved (community/covers.js), while the spine strip's u runs
// along the book's height -- so it takes a quarter turn, as it does on the
// shelf models (bookModel.js). If shared spine art comes out upside down on
// the book in your hand, make this -Math.PI / 2; if it reads mirrored, set
// SPINE_IMAGE_MIRROR.
const SPINE_IMAGE_ROTATION = Math.PI / 2;
const SPINE_IMAGE_MIRROR = false;

// How much is taken off a board's edges. Small on purpose: a real board is
// eased, not rounded over -- it still reads as a rectangle with a definite
// edge. A fraction of the board's own thickness, since that is all the
// material there is to round.
//
// The plan-view CORNERS stay square. The two edge fillets simply run into
// each other and mitre where they meet, which is what a cut board does.
export const EDGE_FILLET_RATIO = 0.35; // of thickness

// Which end of the spine the label's reading direction points at. The
// book's own 'up the page' is +X (PageSimulation.PAGE_TOP_AT_PLUS_X), so
// false gives the English convention of spine text reading top-to-bottom
// when the book is stood upright. Flip for the other convention.
const SPINE_TEXT_TOWARD_PLUS_X = false;

/**
 * @param {THREE.Object3D} parent  where the cover meshes are added -- pass
 *   PageSimulation.root so the cover shares the pages' space and its
 *   render flip.
 * @param {{ H1: () => number, H2: () => number }} hardcoverAngles
 *   accessors for the independent H1 and H2 board angles.
 */
export function createHardcover({ parent, hardcoverAngles }) {
  const square = PANEL_REACH * SQUARE_RATIO;
  const thickness = PANEL_REACH * BOARD_THICKNESS_RATIO;
  const clearance = PANEL_REACH * PAGE_CLEARANCE_RATIO;
  const groove = Math.min(
    PANEL_REACH * GROOVE_WIDTH_RATIO,
    SPINE_GAP * GROOVE_MAX_SPINE_FRACTION,
  );

  const halfWidth = HINGE_LEN / 2 + square; // X half-extent, shared by boards and spine
  // Distance from the page plane out to the board's MID-thickness. The
  // spine is swept at this same distance so its two rails land flush with
  // the boards' inner and outer faces.
  const midOffset = clearance + thickness / 2;

  // How far a board reaches from its hinge to its fore-edge. The groove
  // does not enter into this: the board is unchanged, it is the spine that
  // gives way.
  const boardReach = PANEL_REACH + square;
  const backExtension = PANEL_REACH * BACK_EDGE_EXTENSION_RATIO;
  const boardDepth = boardReach + backExtension;

  // The binding: every face of both boards except the two that face the
  // world, which get their own materials so cover art can go on them
  // without tinting the edges or the inside of the boards.
  const bindingMaterial = new THREE.MeshStandardMaterial({
    color: BOARD_COLOR, roughness: 0.72, metalness: 0.04,
  });
  const frontFaceMaterial = new THREE.MeshStandardMaterial({
    color: BOARD_COLOR, roughness: 0.6, metalness: 0.03,
  });
  const backFaceMaterial = new THREE.MeshStandardMaterial({
    color: BOARD_COLOR, roughness: 0.6, metalness: 0.03,
  });
  // DoubleSide, so see scene/twoSidedShadows.js.
  const spineMaterial = twoSidedShadows(new THREE.MeshStandardMaterial({
    color: SPINE_COLOR, roughness: 0.78, metalness: 0.04, side: THREE.DoubleSide,
  }));

  // Bumped by every setJacket, so one whose images finish loading after a
  // later call has begun gives way rather than overwriting it.
  let jacketToken = 0;

  const H1 = makeBoard(+1, frontFaceMaterial, FACE_PY);
  const H2 = makeBoard(-1, backFaceMaterial, FACE_NY);
  parent.add(H1, H2);

  /**
   * One board, in its page's local frame. `outSign` is which way that
   * page's local +Y points relative to the page block (see the module
   * comment): +1 for the front cover, -1 for the back.
   */
  function makeBoard(outSign, faceMaterial, faceIndex) {
    // Not a BoxGeometry: the corners and edges are eased (boardGeometry.js),
    // which also means three material groups instead of six.
    const geo = createBoardGeometry({
      width: HINGE_LEN + 2 * square, // X: overhangs head and tail
      thickness, // Y: the board's own thickness
      depth: boardDepth, // Z: adds material behind the hinge without moving the fore-edge
      cornerRadius: 0, // sharp corners; the fillets mitre into each other
      edgeRadius: thickness * EDGE_FILLET_RATIO,
    });
    // Z: put the board's inner edge exactly on its own pivot --
    // pageTransform sets a mesh's origin PIVOT_TO_NEAR_EDGE out from the
    // hinge, so local -PIVOT_TO_NEAR_EDGE is the hinge itself and the span
    // runs outward from there.
    // Y: lift the board clear of the page and onto its outward side.
    geo.translate(
      0,
      outSign * midOffset,
      boardReach / 2 - PIVOT_TO_NEAR_EDGE - backExtension / 2,
    );

    const materials = [bindingMaterial, bindingMaterial, bindingMaterial];
    materials[faceIndex] = faceMaterial;

    const mesh = new THREE.Mesh(geo, materials);
    mesh.name = outSign > 0 ? 'H1' : 'H2';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // --- spine -----------------------------------------------------------
  // A FLAT back: a straight slab joining the two boards' hinge edges,
  // with a groove pressed in along each side.
  //
  // It used to be a cubic Bezier left tangent to both boards, which traced
  // a half-cylinder when the book was shut and flattened out as it opened
  // -- a rounded spine. A flat-back binding behaves the other way round:
  // the spine is a rigid slab that never changes shape, and the boards
  // swing on the grooves just inside its edges instead. So the section is
  // now the plain chord, and the only shaping left is the two channels.
  //
  // Still rebuilt every frame rather than posed, because the endpoints are
  // read off the boards and those move; the SHAPE between them no longer
  // changes, so this is now much closer to a rigid piece being re-placed
  // than to a surface being re-solved.
  const spineRows = SPINE_SEGMENTS + 1;
  const spinePositions = new Float32Array(spineRows * 4 * 3); // 4 rails: outer L/R, inner L/R
  const spineGeo = new THREE.BufferGeometry();
  spineGeo.setAttribute('position', new THREE.BufferAttribute(spinePositions, 3));
  spineGeo.setAttribute('uv', new THREE.BufferAttribute(buildSpineUV(spineRows), 2));
  spineGeo.setIndex(buildSpineIndex(spineRows));
  const spineMesh = new THREE.Mesh(spineGeo, spineMaterial);
  spineMesh.name = 'spine';
  spineMesh.castShadow = true;
  spineMesh.receiveShadow = true;
  parent.add(spineMesh);

  /**
   * Put a board at its hinge and independent cover angle.
   *
   * The hinge is the cover page's own -- the block's edge, which is also
   * the groove's outer wall. Posing it further out along the spine (which
   * was tried) swings correctly but leaves the shut board standing a
   * groove-width off the block.
   */
  function poseBoard(mesh, angle, anchorZ) {
    const t = pageTransform({ y: 0, z: anchorZ }, angle);
    mesh.position.set(t.pos.x, t.pos.y, t.pos.z);
    mesh.quaternion.set(t.rot.x, t.rot.y, t.rot.z, t.rot.w);
    mesh.updateMatrix();
  }

  // Scratch, reused every frame.
  const _profileDistance = new Float64Array(spineRows);
  const _profileThickness = new Float64Array(spineRows);
  const _pA = new THREE.Vector3();
  const _axis = new THREE.Vector3();
  const _pt = new THREE.Vector3();
  const _nrm = new THREE.Vector3();


  function updateSpine() {
    // Ends taken off the spine line, stopping a groove SHORT of the page
    // block's edge at each side -- the boards still hinge on the block's
    // edge, so that shortfall is the joint.
    //
    // Read from the block rather than from the boards, which also makes the
    // slab rigid: its endpoints no longer swing when a cover opens, exactly
    // as a flat back behaves. Only a change of spine tilt or of book
    // thickness moves it now.
    // Ends are the block's own edges -- the same line the boards hinge on,
    // so the spine reaches all the way to them. Where the joint goes is a
    // matter of the PROFILE below, not of stopping short.
    const endA = spineHinge(SPINE_GAP).mid;
    const endD = spineHinge(-SPINE_GAP).mid;

    _axis.set(endD.x - endA.x, endD.y - endA.y, endD.z - endA.z);
    const span = _axis.length();
    if (span > 1e-9) _axis.divideScalar(span);

    // The section lies in a plane of constant X, so the outward normal is
    // the axis turned a quarter turn within it -- and THIS quarter turn is
    // already the outward one. Going A (+z) to D (-z) makes the axis
    // (0, sin B, -cos B) for a spine tilt B, so this evaluates to
    // (0, cos B, sin B): +Y when flat, which is the side the pages are not
    // on. It must not be "corrected" against a board's own normal -- with
    // the book shut a board faces along Z while this faces Y, the two are
    // perpendicular, and the sign test then flips the slab inside the
    // block, where it shows through the pages.
    _nrm.set(0, -_axis.z, _axis.y).normalize();

    // The face that lies against the page block. Held CONSTANT across the
    // whole spine: the groove is a recess in the OUTSIDE of the cover, so
    // the inside stays flat against the block and continuous with each
    // board's inner face. A thinner row therefore has to shift its
    // centreline as well, which is why the offset below adds halfThick
    // rather than a fixed midOffset.
    const innerSurface = midOffset - thickness / 2;
    _pA.set(endA.x, endA.y, endA.z);

    // Six rows: thin strip, step, slab, step, thin strip. Rows 1/2 and 3/4
    // share a position -- that is the step.
    const thin = thickness * GROOVE_THICKNESS_RATIO;
    _profileDistance[0] = 0;
    _profileDistance[1] = groove;
    _profileDistance[2] = groove;
    _profileDistance[3] = span - groove;
    _profileDistance[4] = span - groove;
    _profileDistance[5] = span;
    _profileThickness[0] = thin;
    _profileThickness[1] = thin;
    _profileThickness[2] = thickness;
    _profileThickness[3] = thickness;
    _profileThickness[4] = thin;
    _profileThickness[5] = thin;

    const uv = spineGeo.attributes.uv.array;

    for (let i = 0; i < spineRows; i++) {
      const distance = _profileDistance[i];
      const halfThick = _profileThickness[i] / 2;

      _pt.copy(_pA)
        .addScaledVector(_axis, distance)
        .addScaledVector(_nrm, innerSurface + halfThick);

      writeSpineRow(spinePositions, spineRows, i, _pt, _nrm, halfWidth, halfThick);

      // v by REAL distance along the spine, not by row index. Two pairs of
      // rows sit at the same place, so an index-based v would spend a fifth
      // of the label on each zero-width step and leave the slab -- almost
      // the whole spine -- with a fifth of it.
      const v = span > 1e-9 ? distance / span : 0;
      for (let rail = 0; rail < 4; rail++) {
        uv[(rail * spineRows + i) * 2 + 1] = v;
      }
    }
    spineGeo.attributes.uv.needsUpdate = true;

    spineGeo.attributes.position.needsUpdate = true;
    spineGeo.computeVertexNormals();
    // Both, not just the sphere: culling reads the sphere, but Box3
    // .setFromObject reuses a cached boundingBox and would otherwise keep
    // handing back the degenerate one from before the first sweep ran.
    spineGeo.computeBoundingSphere();
    spineGeo.computeBoundingBox();
  }

  return {
    H1,
    H2,
    spineMesh,

    /**
     * The boards as a COLLISION shape, for the physics that drops the book
     * on the desk (book/placement/bookPlacement.js). Both boards are the
     * same box; only their transforms differ, and those are already on
     * H1.matrix / H2.matrix.
     *
     * Still a plain cuboid, even though the board's own mesh now has eased
     * corners and edges: that rounding is a millimetre of cosmetics and
     * squaring it off costs nothing a reader could feel when the book
     * lands on the desk.
     *
     * `centerOffset` is the same shift makeBoard() bakes into the geometry
     * -- the board is built centred on its own origin and then translated,
     * so a collider copying only the mesh transform would sit in the wrong
     * place. The two have to stay in step, which is why this is derived
     * here rather than re-measured by the caller.
     *
     * Regenerated on read (cheap, three numbers) so a book re-sized by a
     * loaded PDF reports its new board size rather than a stale one.
     */
    get boardShape() {
      return {
        halfExtents: {
          x: HINGE_LEN / 2 + square,
          y: thickness / 2,
          z: (PANEL_REACH + square) / 2,
        },
        // outSign is +1 for H1 and -1 for H2 -- see makeBoard.
        centerOffset: { H1: { x: 0, y: midOffset, z: square / 2 },
          H2: { x: 0, y: -midOffset, z: square / 2 } },
      };
    },

    /**
     * Dress the book in a jacket. The front board takes the cover image --
     * the epub's own, or a shared cover's (the Community tab). A shared
     * cover brings its own spine and back as well; otherwise those are
     * SYNTHESIZED, because epub carries a front cover and nothing else -- no
     * back and no spine artwork exists in the format to extract. The binding
     * colour is sampled from the cover's border so the whole jacket reads as
     * one object, and a synthesized spine gets the title and author printed
     * along it the way a shelved book does.
     *
     * Safe to call with no images at all: the spine label and binding still
     * render, just over the default board colour. Every call replaces the
     * whole jacket, so a shared cover taken off leaves the book as it was;
     * an image that fails to load is left off rather than failing the rest.
     *
     * @param {{ coverUrl?: string|null, spineUrl?: string|null,
     *           backUrl?: string|null, title?: string|null,
     *           author?: string|null }} jacket
     */
    async setJacket({
      coverUrl = null, spineUrl = null, backUrl = null, title = null, author = null,
    } = {}) {
      const token = (jacketToken += 1);
      const loader = new THREE.TextureLoader();
      const load = (url) => {
        if (!url) return Promise.resolve(null);
        return loader.loadAsync(url).then((texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = 8;
          return texture;
        }, (err) => {
          console.warn(`Jacket image failed to load: ${url}`, err);
          return null;
        });
      };
      const [cover, spineArt, back] = await Promise.all([load(coverUrl), load(spineUrl), load(backUrl)]);
      // A later jacket started while these were loading: it wins.
      if (token !== jacketToken) {
        for (const texture of [cover, spineArt, back]) texture?.dispose();
        return null;
      }

      let binding = { r: 74, g: 47, b: 36 }; // BOARD_COLOR, if there is no art to sample
      if (cover?.image) binding = sampleBindingColor(cover.image);

      frontFaceMaterial.map?.dispose();
      frontFaceMaterial.map = cover;
      // The art's own colours, unmultiplied -- or, with none, the plain board.
      frontFaceMaterial.color.set(cover ? 0xffffff : BOARD_COLOR);
      frontFaceMaterial.needsUpdate = true;

      bindingMaterial.color.set(toHex(binding));

      // A shared cover's own back, turned as the front is. Without one, a
      // touch darker than the front, the way a back board sits in shadow
      // and stops the book reading as identical from both sides.
      backFaceMaterial.map?.dispose();
      backFaceMaterial.map = back;
      backFaceMaterial.color.set(back ? 0xffffff : toHex(shade(binding, 0.86)));
      backFaceMaterial.needsUpdate = true;

      spineMaterial.map?.dispose();
      if (spineArt) {
        spineArt.center.set(0.5, 0.5);
        spineArt.rotation = SPINE_IMAGE_ROTATION;
        if (SPINE_IMAGE_MIRROR) spineArt.repeat.set(-1, 1);
        spineMaterial.map = spineArt;
      } else {
        // The label canvas is laid out along the spine's own proportions --
        // its long axis is the book's height, its short one the thickness --
        // so the arc it wraps onto is not distorted.
        // Developed width of the spine, over its height. Was PI * radius,
        // the arc length of the half-cylinder the old rounded spine traced;
        // a flat back just spans the chord, which is about 2/3 of that, so
        // leaving it would have stretched the title along the spine.
        const spineWidth = 2 * (SPINE_GAP + midOffset);
        const aspect = Math.max(0.04, spineWidth / (HINGE_LEN + 2 * square));
        const labelCanvas = renderSpineLabel({
          title, author, background: binding,
          lengthPx: 1024, widthPx: Math.round(1024 * aspect),
        });
        const labelTexture = new THREE.CanvasTexture(labelCanvas);
        labelTexture.colorSpace = THREE.SRGBColorSpace;
        labelTexture.anisotropy = 8;
        spineMaterial.map = labelTexture;
      }
      spineMaterial.color.set(0xffffff);
      spineMaterial.needsUpdate = true;

      return { binding, hasCover: Boolean(cover) };
    },

    /** Call once per frame, after the physics step. */
    update() {
      const angleH1 = hardcoverAngles.H1();
      const angleH2 = hardcoverAngles.H2();
      poseBoard(H1, angleH1, SPINE_GAP);
      poseBoard(H2, angleH2, -SPINE_GAP);
      updateSpine();
    },

    dispose() {
      for (const mesh of [H1, H2, spineMesh]) {
        parent.remove(mesh);
        mesh.geometry.dispose();
      }
      for (const mat of [bindingMaterial, frontFaceMaterial, backFaceMaterial, spineMaterial]) {
        mat.map?.dispose();
        mat.dispose();
      }
    },
  };
}

// Rails, in order: 0 = outer-left, 1 = outer-right, 2 = inner-left,
// 3 = inner-right. Each occupies `rows` consecutive vertices.
function writeSpineRow(positions, rows, row, point, normal, halfWidth, halfThick) {
  const ox = point.x, oy = point.y + normal.y * halfThick, oz = point.z + normal.z * halfThick;
  const ix = point.x, iy = point.y - normal.y * halfThick, iz = point.z - normal.z * halfThick;
  const put = (rail, x, y, z) => {
    const o = (rail * rows + row) * 3;
    positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
  };
  put(0, ox - halfWidth, oy, oz);
  put(1, ox + halfWidth, oy, oz);
  put(2, ix - halfWidth, iy, iz);
  put(3, ix + halfWidth, iy, iz);
}

// u runs across the book's height (rail to rail), v around the sweep, so
// a label canvas laid out long-axis-first maps straight on. Static: the
// spine flexes but never changes how the label is distributed over it.
function buildSpineUV(rows) {
  const uv = new Float32Array(rows * 4 * 2);
  const uLeft = SPINE_TEXT_TOWARD_PLUS_X ? 0 : 1;
  const uRight = SPINE_TEXT_TOWARD_PLUS_X ? 1 : 0;
  for (let rail = 0; rail < 4; rail++) {
    const u = rail % 2 === 0 ? uLeft : uRight; // rails 0/2 are -X, 1/3 are +X
    for (let row = 0; row < rows; row++) {
      const o = (rail * rows + row) * 2;
      uv[o] = u;
      uv[o + 1] = row / (rows - 1);
    }
  }
  return uv;
}

// Outer surface, inner surface, and the two head/tail sides. The ends are
// left open -- each is buried inside the board it meets.
function buildSpineIndex(rows) {
  const idx = [];
  const OL = 0, OR = 1, IL = 2, IR = 3;
  const v = (rail, row) => rail * rows + row;
  const quad = (a, b, c, d) => { idx.push(a, b, c, a, c, d); };

  for (let i = 0; i < rows - 1; i++) {
    quad(v(OL, i), v(OR, i), v(OR, i + 1), v(OL, i + 1)); // outer
    quad(v(IR, i), v(IL, i), v(IL, i + 1), v(IR, i + 1)); // inner
    quad(v(IL, i), v(OL, i), v(OL, i + 1), v(IL, i + 1)); // -X side
    quad(v(OR, i), v(IR, i), v(IR, i + 1), v(OR, i + 1)); // +X side
  }
  return idx;
}
