import * as THREE from 'three';
import { HINGE_LEN, PANEL_REACH, SPINE_GAP } from '../pageSim/config.js';
import { sampleBindingColor, renderSpineLabel, toHex, shade, luminance } from './jacketArt.js';

/**
 * The book's hardcover: two rigid boards that ride the outer cover pages
 * (A and D), plus a spine that bridges them.
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
 * WHICH SIDE IS OUTSIDE. A board sits on the face of its page pointing
 * away from the page block. In the page's local frame that is a constant
 * (+Y for the front board, -Y for the back), which is what lets the board
 * simply copy its page's transform. To see why: the four panels only sit
 * face-to-face when the book is closed, which is the pose where every
 * page angle is BC_MEET_ANGLE (pi/2), and there a page's local +Y maps to
 * world +Z -- the same axis the panels are stacked along, with A at the
 * +Z end of the stack and D at the -Z end. So +Y points out of the stack
 * for A and into it for D. Being rigidly attached, that holds in every
 * other pose too: open flat (A at 0, D at pi) both boards end up on the
 * underside, which is exactly where a real book's covers lie against the
 * table.
 *
 * The boards are render-only -- they carry no rigid bodies and add no
 * constraints. They inherit their motion wholesale from cover pages that
 * are already simulated, so the hardcover cannot perturb the page physics
 * it is drawn around.
 */

// All proportional to the page so a re-sized book (a loaded PDF changes
// HINGE_LEN/PANEL_REACH/SPINE_GAP) keeps the same cover proportions.
const SQUARE_RATIO = 0.025; // overhang past the page, as a fraction of PANEL_REACH
const BOARD_THICKNESS_RATIO = 0.02; // board thickness, likewise
const PAGE_CLEARANCE_RATIO = 0.01; // gap between the page surface and the board's inner face

const SPINE_SEGMENTS = 24;

const BOARD_COLOR = 0x4a2f24; // plain binding, until a jacket is applied
const SPINE_COLOR = 0x3d2620;

// BoxGeometry emits its six faces in this order, so the outward face of
// a board -- local +Y on the front, -Y on the back -- is the group that
// takes the cover art.
const FACE_PY = 2;
const FACE_NY = 3;

// Which end of the spine the label's reading direction points at. The
// book's own 'up the page' is +X (PageSimulation.PAGE_TOP_AT_PLUS_X), so
// false gives the English convention of spine text reading top-to-bottom
// when the book is stood upright. Flip for the other convention.
const SPINE_TEXT_TOWARD_PLUS_X = false;

/**
 * @param {THREE.Object3D} parent  where the cover meshes are added -- pass
 *   PageSimulation.root so the cover shares the pages' space and its
 *   render flip.
 * @param {{ front: THREE.Mesh, back: THREE.Mesh }} coverPages  the A and D
 *   flat page meshes, already transform-synced each frame by their spread.
 */
export function createHardcover({ parent, coverPages }) {
  const square = PANEL_REACH * SQUARE_RATIO;
  const thickness = PANEL_REACH * BOARD_THICKNESS_RATIO;
  const clearance = PANEL_REACH * PAGE_CLEARANCE_RATIO;

  const halfWidth = HINGE_LEN / 2 + square; // X half-extent, shared by boards and spine
  // Distance from the page plane out to the board's MID-thickness. The
  // spine curve is sampled at this same distance so its two rails land
  // flush with the boards' inner and outer faces.
  const midOffset = clearance + thickness / 2;

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
  const spineMaterial = new THREE.MeshStandardMaterial({
    color: SPINE_COLOR, roughness: 0.78, metalness: 0.04, side: THREE.DoubleSide,
  });

  const frontBoard = makeBoard(+1, frontFaceMaterial, FACE_PY);
  const backBoard = makeBoard(-1, backFaceMaterial, FACE_NY);
  parent.add(frontBoard, backBoard);

  /**
   * One board, in its page's local frame. `outSign` is which way that
   * page's local +Y points relative to the page block (see the module
   * comment): +1 for the front cover, -1 for the back.
   */
  function makeBoard(outSign, faceMaterial, faceIndex) {
    const geo = new THREE.BoxGeometry(
      HINGE_LEN + 2 * square, // X: overhangs head and tail
      thickness, // Y: the board's own thickness
      PANEL_REACH + square, // Z: overhangs the fore-edge only
    );
    // Z: the hinge edge stays put at -PANEL_REACH/2 and the whole square
    // is spent at the fore-edge, so the span shifts out by half of it.
    // Y: lift the board clear of the page and onto its outward side.
    geo.translate(0, outSign * midOffset, square / 2);

    const materials = Array(6).fill(bindingMaterial);
    materials[faceIndex] = faceMaterial;

    const mesh = new THREE.Mesh(geo, materials);
    mesh.name = outSign > 0 ? 'frontBoard' : 'backBoard';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // --- spine -----------------------------------------------------------
  // A swept strip joining the two boards' hinge edges around the outside
  // of the book. Its cross-section is a cubic Bezier pinned to each
  // board's hinge edge and leaving it TANGENT to that board, so the cover
  // reads as one continuous piece however far the book is opened. Control
  // points sit 2/3 of the chord along those tangents, the standard cubic
  // approximation to a circular arc: closed (both covers at pi/2, tangents
  // antiparallel) that traces a half-cylinder of radius ~SPINE_GAP, the
  // familiar rounded spine; open flat (0 and pi, tangents now parallel and
  // pointing the same way down the chord) the same formula degenerates to
  // a straight strip lying between the two boards, which is what a spine
  // does on a table. Nothing special-cases either pose.
  //
  // Rebuilt every frame rather than posed, because both endpoints AND both
  // tangents move with the covers -- there is no rigid transform that
  // could carry a fixed mesh between those states.
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

  // Scratch, reused every frame.
  const _hinge = new THREE.Vector3();
  const _out = new THREE.Vector3();
  const _fore = new THREE.Vector3();
  const _pA = new THREE.Vector3();
  const _pD = new THREE.Vector3();
  const _tA = new THREE.Vector3();
  const _tD = new THREE.Vector3();
  const _c1 = new THREE.Vector3();
  const _c2 = new THREE.Vector3();
  const _pt = new THREE.Vector3();
  const _tan = new THREE.Vector3();
  const _nrm = new THREE.Vector3();
  const curve = new THREE.CubicBezierCurve3(_pA, _c1, _c2, _pD);

  /**
   * Reads a cover page's current transform and returns, in parent space,
   * its hinge-edge midpoint, its outward normal and its fore-edge
   * direction. `outSign` matches makeBoard's.
   */
  function readCover(pageMesh, outSign, hinge, out, fore) {
    hinge.set(0, 0, -PANEL_REACH / 2).applyMatrix4(pageMesh.matrix);
    out.set(0, outSign, 0).transformDirection(pageMesh.matrix);
    fore.set(0, 0, 1).transformDirection(pageMesh.matrix);
    return hinge;
  }

  function updateSpine() {
    // Front cover: hinge edge, lifted to the board's mid-thickness.
    readCover(coverPages.front, +1, _hinge, _out, _fore);
    _pA.copy(_hinge).addScaledVector(_out, midOffset);
    _tA.copy(_fore).negate(); // leaves the front board heading away from its fore-edge

    // Back cover: same, and the curve ARRIVES travelling into its
    // fore-edge, so the tangent there is +fore rather than -fore.
    readCover(coverPages.back, -1, _hinge, _out, _fore);
    _pD.copy(_hinge).addScaledVector(_out, midOffset);
    _tD.copy(_fore);

    const chord = _pA.distanceTo(_pD);
    const handle = (2 / 3) * chord;
    _c1.copy(_pA).addScaledVector(_tA, handle);
    _c2.copy(_pD).addScaledVector(_tD, -handle);

    for (let i = 0; i < spineRows; i++) {
      const t = i / SPINE_SEGMENTS;
      curve.getPoint(t, _pt);
      curve.getTangent(t, _tan);
      // The whole curve lies in a plane of constant X, so its outward
      // normal is just the tangent turned a quarter turn within that
      // plane. Signed so it points out of the book, matching _out above.
      _nrm.set(0, -_tan.z, _tan.y).normalize();

      writeSpineRow(spinePositions, spineRows, i, _pt, _nrm, halfWidth, thickness / 2);
    }

    spineGeo.attributes.position.needsUpdate = true;
    spineGeo.computeVertexNormals();
    // Both, not just the sphere: culling reads the sphere, but Box3
    // .setFromObject reuses a cached boundingBox and would otherwise keep
    // handing back the degenerate one from before the first sweep ran.
    spineGeo.computeBoundingSphere();
    spineGeo.computeBoundingBox();
  }

  return {
    frontBoard,
    backBoard,
    spineMesh,

    /**
     * Dress the book in a jacket. The front board takes the epub's own
     * cover image; the spine and back board are SYNTHESIZED from it,
     * because epub carries a front cover and nothing else -- no back and
     * no spine artwork exists in the format to extract. The binding
     * colour is sampled from the cover's border so the whole jacket reads
     * as one object, and the spine gets the title and author printed
     * along it the way a shelved book does.
     *
     * Safe to call with a null coverUrl (or none at all): the spine label
     * and binding still render, just over the default board colour.
     *
     * @param {{ coverUrl?: string|null, title?: string|null,
     *           author?: string|null }} jacket
     */
    async setJacket({ coverUrl = null, title = null, author = null } = {}) {
      let binding = { r: 74, g: 47, b: 36 }; // BOARD_COLOR, if there is no art to sample

      if (coverUrl) {
        const texture = await new THREE.TextureLoader().loadAsync(coverUrl);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        if (texture.image) binding = sampleBindingColor(texture.image);

        frontFaceMaterial.map?.dispose();
        frontFaceMaterial.map = texture;
        frontFaceMaterial.color.set(0xffffff); // show the art's own colours, unmultiplied
        frontFaceMaterial.needsUpdate = true;
      }

      bindingMaterial.color.set(toHex(binding));
      // A touch darker than the front, the way a back board sits in shadow
      // and stops the book reading as identical from both sides.
      backFaceMaterial.color.set(toHex(shade(binding, 0.86)));

      // The label canvas is laid out along the spine's own proportions --
      // its long axis is the book's height, its short one the thickness --
      // so the arc it wraps onto is not distorted.
      const aspect = Math.max(0.04, (Math.PI * (SPINE_GAP + midOffset)) / (HINGE_LEN + 2 * square));
      const labelCanvas = renderSpineLabel({
        title, author, background: binding,
        lengthPx: 1024, widthPx: Math.round(1024 * aspect),
      });
      spineMaterial.map?.dispose();
      const labelTexture = new THREE.CanvasTexture(labelCanvas);
      labelTexture.colorSpace = THREE.SRGBColorSpace;
      labelTexture.anisotropy = 8;
      spineMaterial.map = labelTexture;
      spineMaterial.color.set(0xffffff);
      spineMaterial.needsUpdate = true;

      return { binding, hasCover: Boolean(coverUrl) };
    },

    /** Call once per frame, after the cover pages have been synced. */
    update() {
      // The boards are rigidly attached to their pages, so riding the
      // page's transform outright is both exact and free.
      frontBoard.position.copy(coverPages.front.position);
      frontBoard.quaternion.copy(coverPages.front.quaternion);
      backBoard.position.copy(coverPages.back.position);
      backBoard.quaternion.copy(coverPages.back.quaternion);
      frontBoard.updateMatrix();
      backBoard.updateMatrix();

      updateSpine();
    },

    dispose() {
      for (const mesh of [frontBoard, backBoard, spineMesh]) {
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
