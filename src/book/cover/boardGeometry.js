import * as THREE from 'three';

/**
 * A cover board: squared off, but with its corners and edges taken off the
 * way a real board's are. Built as three material groups.
 *
 *   group 0   the +Y face   -- takes the cover art on the front board
 *   group 1   the -Y face   -- takes it on the back board
 *   group 2   the rim       -- always the binding
 *
 * WHY NOT RoundedBoxGeometry. three.js ships one, but it emits a single
 * material group, and a board needs the art on exactly one face and the
 * binding everywhere else. BoxGeometry gave that for free via its six
 * groups, which is what this has to replace.
 *
 * SHAPE. Two radii, doing different jobs, and both meant to be SMALL --
 * the board should still read as a rectangle that has been eased, not as a
 * pill:
 *
 *   cornerRadius  rounds the four corners in PLAN, looking down at the
 *                 closed book. Normally 0 -- a board's corners are sharp,
 *                 and the edge fillets simply run into each other and
 *                 mitre there.
 *   edgeRadius    a fillet where each face meets the rim. Between the two
 *                 fillets the rim is a straight vertical wall, so the
 *                 board keeps a definite edge instead of bulging.
 *
 * Every ring of the rim is the SAME outline at a different inset --
 * offsetting a rounded rectangle inward just shrinks its half-extents and
 * its corner radius by the same amount. That is what keeps the rings
 * index-aligned so the rim quads stay clean, and it is why the caps can
 * reuse the outline too.
 */

/**
 * A closed rounded-rectangle outline, as flat [x, z, x, z, ...] written
 * into `out`. Returns how many points it wrote.
 */
function outlineAt(halfX, halfZ, cornerRadius, inset, cornerSegments, out) {
  const hx = Math.max(1e-6, halfX - inset);
  const hz = Math.max(1e-6, halfZ - inset);
  const r = Math.max(0, Math.min(cornerRadius - inset, Math.min(hx, hz)));

  let w = 0;
  for (let corner = 0; corner < 4; corner++) {
    // Corner centres, counter-clockwise in (x, z) starting from +X/+Z.
    const signX = corner === 0 || corner === 3 ? 1 : -1;
    const signZ = corner === 0 || corner === 1 ? 1 : -1;
    const cx = signX * (hx - r);
    const cz = signZ * (hz - r);
    const start = (corner * Math.PI) / 2;

    for (let i = 0; i <= cornerSegments; i++) {
      const a = start + (i / cornerSegments) * (Math.PI / 2);
      out[w++] = cx + r * Math.cos(a);
      out[w++] = cz + r * Math.sin(a);
    }
  }
  return w / 2;
}

/**
 * @param {object} opts
 * @param {number} opts.width      X extent (along the spine)
 * @param {number} opts.depth      Z extent (hinge to fore-edge)
 * @param {number} opts.thickness  Y extent
 * @param {number} opts.cornerRadius  plan-view corner rounding
 * @param {number} opts.edgeRadius    fillet where a face meets the rim;
 *   clamped to half the thickness, where it would become a full bullnose
 * @param {number} [opts.cornerSegments=1]  arc resolution per plan corner.
 *   1 is the right value for a SHARP corner and is not a degenerate case:
 *   with cornerRadius 0 it emits the corner point twice, so the two walls
 *   meeting there get their own vertices instead of sharing one. That is
 *   what keeps the corner crisp -- computeVertexNormals averages whatever
 *   a vertex is shared by, so a single shared corner vertex would blend
 *   the two walls' normals and shade the corner round even though the
 *   geometry is square. The zero-width quad between the pair costs
 *   nothing and draws nothing.
 * @param {number} [opts.edgeSegments=2]  arc resolution per fillet
 */
export function createBoardGeometry({
  width, depth, thickness, cornerRadius = 0, edgeRadius,
  cornerSegments = 1, edgeSegments = 2,
}) {
  const halfX = width / 2;
  const halfZ = depth / 2;
  const halfY = thickness / 2;
  const fillet = Math.max(0, Math.min(edgeRadius, halfY));

  const pointCount = 4 * (cornerSegments + 1);
  const scratch = new Float64Array(pointCount * 2);

  const positions = [];
  const uvs = [];
  const topIndex = [];
  const bottomIndex = [];
  const rimIndex = [];

  // Cap uv, matching what BoxGeometry produced for its py / ny faces so a
  // cover image keeps the orientation it had before this replaced a box:
  // u always runs with +X; v runs with -Z on the top face, +Z on the bottom.
  const capU = (x) => (x + halfX) / width;
  const capV = (z, up) => (up ? 1 - (z + halfZ) / depth : (z + halfZ) / depth);

  // --- rim rings ---------------------------------------------------------
  // Top fillet, then bottom fillet. The straight wall between them needs no
  // rings of its own: it is simply the quad joining the last ring of the
  // top fillet to the first of the bottom, both of which sit at inset 0.
  const rings = [];
  for (let i = 0; i <= edgeSegments; i++) {
    const a = (Math.PI / 2) * (i / edgeSegments); // 0 at the face, PI/2 at the wall
    rings.push({ y: halfY - fillet + fillet * Math.cos(a), inset: fillet * (1 - Math.sin(a)) });
  }
  for (let i = edgeSegments; i >= 0; i--) {
    const a = (Math.PI / 2) * (i / edgeSegments);
    rings.push({ y: -(halfY - fillet) - fillet * Math.cos(a), inset: fillet * (1 - Math.sin(a)) });
  }

  const ringStart = [];
  for (const ring of rings) {
    outlineAt(halfX, halfZ, cornerRadius, ring.inset, cornerSegments, scratch);
    ringStart.push(positions.length / 3);
    for (let i = 0; i < pointCount; i++) {
      positions.push(scratch[i * 2], ring.y, scratch[i * 2 + 1]);
      uvs.push(i / pointCount, (ring.y + halfY) / thickness);
    }
  }

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const a = ringStart[ring];
    const b = ringStart[ring + 1];
    for (let i = 0; i < pointCount; i++) {
      const j = (i + 1) % pointCount; // closed loop
      // Wound to face OUT. Rings run top-to-bottom (decreasing y) while the
      // outline runs counter-clockwise in (x, z), and taking those two in
      // their natural order gives an inward normal -- on the +X wall the
      // edges come out (0, -dy, 0) and (0, 0, +dz), crossing to -X. Which
      // renders as a rim that vanishes from outside the board and is only
      // visible from within it. Hence j before i on the first triangle and
      // a before b on the second.
      rimIndex.push(a + i, b + j, b + i);
      rimIndex.push(a + i, a + j, b + j);
    }
  }

  // --- caps --------------------------------------------------------------
  // A fan around each face's centre, over the outline inset by the fillet --
  // the same ring the rim starts from, but duplicated so the cap carries its
  // own flat normal and its own uv rather than sharing the rim's.
  function addCap(up) {
    const y = up ? halfY : -halfY;
    const index = up ? topIndex : bottomIndex;

    const centre = positions.length / 3;
    positions.push(0, y, 0);
    uvs.push(capU(0), capV(0, up));

    const first = positions.length / 3;
    outlineAt(halfX, halfZ, cornerRadius, fillet, cornerSegments, scratch);
    for (let i = 0; i < pointCount; i++) {
      const x = scratch[i * 2];
      const z = scratch[i * 2 + 1];
      positions.push(x, y, z);
      uvs.push(capU(x), capV(z, up));
    }

    for (let i = 0; i < pointCount; i++) {
      const j = (i + 1) % pointCount;
      // The outline runs counter-clockwise in (x, z), which reads CLOCKWISE
      // seen from +Y. So the top face has to take its points in reverse to
      // come out front-facing, and the bottom face takes them as they are.
      if (up) index.push(centre, first + j, first + i);
      else index.push(centre, first + i, first + j);
    }
  }
  addCap(true);
  addCap(false);

  // --- assemble ----------------------------------------------------------
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([...topIndex, ...bottomIndex, ...rimIndex]);

  geometry.addGroup(0, topIndex.length, 0);
  geometry.addGroup(topIndex.length, bottomIndex.length, 1);
  geometry.addGroup(topIndex.length + bottomIndex.length, rimIndex.length, 2);

  geometry.computeVertexNormals();
  return geometry;
}

// Which group each face's material belongs in -- the analogue of
// BoxGeometry's FACE_PY / FACE_NY, for callers building the material array.
export const BOARD_FACE_PY = 0;
export const BOARD_FACE_NY = 1;
export const BOARD_FACE_RIM = 2;
