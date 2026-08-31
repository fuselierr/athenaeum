import * as THREE from 'three';
import { AXIS_X, clampNum } from './math.js';

/**
 * Page-curl geometry.
 *
 * The two inner pages are rendered as a bent strip instead of a rigid flat
 * plane, so they form the curve of the book's inside as it opens. Right at
 * its own hinge the strip's tangent matches the page's current physical
 * angle (no kink at the joint); it then curves through a circular arc of
 * radius SPINE_GAP until its tangent lines up with the reference page's
 * (the facing cover's) current direction, and continues straight from
 * there. Arc + straight lengths always sum to PANEL_REACH, so the strip
 * never stretches or shrinks — more curl just eats more of that fixed
 * length into the arc.
 */

export const CURL_SEGS = 20;
export const CURL_ROWS = CURL_SEGS + 2; // arc rows (CURL_SEGS + 1) plus one straight-tip row

export const CURL_INDEX = (() => {
  const idx = [];
  const left = (i) => i;
  const right = (i) => CURL_ROWS + i;
  for (let i = 0; i < CURL_ROWS - 1; i++) {
    idx.push(left(i), left(i + 1), right(i + 1));
    idx.push(left(i), right(i + 1), right(i));
  }
  return idx;
})();

// UV layout for the curl strip: u=0/1 for the left/right column (static --
// HINGE_LEN doesn't change row to row). v used to be assigned by ROW INDEX
// (i/(CURL_ROWS-1)) on the reasoning that arc-length-based v would make the
// texture "stretch or slide" as the page bends. In practice that made the
// texture badly non-uniform instead: CURL_SEGS (20) of the CURL_ROWS (22)
// rows are always inside the ARC, regardless of how much of PANEL_REACH the
// arc actually currently occupies -- so whenever the arc is a small
// fraction of the page's length (the common case away from the spine), a
// texture's full height gets crammed into that small arc while the much
// longer straight run gets stretched from only the 1-2 rows outside it,
// which is what showed up as "the text is only on the curve, the extended
// (straight) part is blank" -- that blank look is really the source image
// stretched so thin across that huge a run that it reads as a flat color.
//
// v is now written PER-FRAME from curlRowFrac -- the actual cumulative
// arc-length fraction spread.js's updateCurlMesh already computes for the
// wedge loft -- via writeCurlUV below, so the texture is evenly spread
// across the page's real current length (arc + straight together) instead
// of by row count. The tradeoff the row-index approach was trying to avoid
// (texture appearing to slide as curl amount changes) is the lesser
// problem -- a page's rendered content shifting slightly as it curls reads
// far better than most of it being invisible.
export function createCurlUV() {
  return new Float32Array(2 * CURL_ROWS * 2);
}

// v = 1 - curlRowFrac[i], NOT curlRowFrac[i]: curlRowFrac[0] = 0 at the
// hinge/spine end and 1 at the tip end (same direction buildCurlStrip's row
// 0 starts from, right at the anchor). The flat pages' default
// PlaneGeometry UV has v=0 at the TIP and v=1 at the pivot/hinge -- the
// opposite convention. Matching that here is what keeps a page's texture
// right-side-up on the curl mesh instead of appearing upside-down.
export function writeCurlUV(uv, curlRowFrac) {
  for (let i = 0; i < CURL_ROWS; i++) {
    const v = 1 - curlRowFrac[i];
    const li = i * 2, ri = (CURL_ROWS + i) * 2;
    uv[li] = 0; uv[li + 1] = v;
    uv[ri] = 1; uv[ri + 1] = v;
  }
}

const _curl = {
  dirStart: new THREE.Vector3(), dirEnd: new THREE.Vector3(), axis: new THREE.Vector3(),
  radialStart: new THREE.Vector3(), radial: new THREE.Vector3(), pos: new THREE.Vector3(),
  tip: new THREE.Vector3(),
};

/**
 * Writes CURL_ROWS pairs of (left, right) vertices into `positions`, tracing
 * the curling page from `anchorPoint` — tangent = `curlAngle`'s direction —
 * through a radius-`radius` arc until the tangent matches `refAngle`'s
 * direction, then straight, for a total length of `totalLength`.
 * Returns the world-space tip centre point (reused across calls — consume it
 * before calling again).
 */
export function buildCurlStrip(positions, anchorPoint, curlAngle, refAngle, radius, totalLength, halfWidth) {
  const dirStart = _curl.dirStart.set(0, -Math.sin(curlAngle), Math.cos(curlAngle));
  const dirEnd = _curl.dirEnd.set(0, -Math.sin(refAngle), Math.cos(refAngle));
  const sweep = dirStart.angleTo(dirEnd);
  const axis = _curl.axis.crossVectors(dirStart, dirEnd);
  if (axis.lengthSq() < 1e-10) axis.set(1, 0, 0); else axis.normalize();
  const arcLen = Math.min(radius * sweep, totalLength);
  const straightLen = Math.max(0, totalLength - arcLen);
  // Vector from the (never-materialized) arc centre to the anchor point:
  // rotating it by theta about `axis` and re-adding the anchor keeps the
  // tangent at theta = 0 exactly dirStart, and at theta = sweep exactly
  // dirEnd.
  const radialStart = _curl.radialStart.crossVectors(dirStart, axis);

  const writeRow = (row, center) => {
    const li = row * 3, ri = (CURL_ROWS + row) * 3;
    positions[li] = center.x - halfWidth; positions[li + 1] = center.y; positions[li + 2] = center.z;
    positions[ri] = center.x + halfWidth; positions[ri + 1] = center.y; positions[ri + 2] = center.z;
  };

  let curveEnd = null;
  for (let i = 0; i <= CURL_SEGS; i++) {
    const theta = (i / CURL_SEGS) * sweep;
    const radial = _curl.radial.copy(radialStart).applyAxisAngle(axis, theta);
    const p = _curl.pos.copy(radial).sub(radialStart).multiplyScalar(radius).add(anchorPoint);
    writeRow(i, p);
    if (i === CURL_SEGS) curveEnd = p;
  }
  const tip = _curl.tip.copy(dirEnd).multiplyScalar(straightLen).add(curveEnd);
  writeRow(CURL_SEGS + 1, tip);
  return tip;
}

// Same closed-form endpoint buildCurlStrip's last row computes, without
// writing the whole ribbon — for the bisection search in enforceNoCrossing,
// which only needs the tip.
const _tipCalc = {
  dirStart: new THREE.Vector3(), dirEnd: new THREE.Vector3(), axis: new THREE.Vector3(),
  radialStart: new THREE.Vector3(), radialEnd: new THREE.Vector3(), tmp: new THREE.Vector3(),
};
export function curlTipPoint(anchorPoint, curlAngle, refAngle, radius, totalLength, out) {
  const s = _tipCalc;
  s.dirStart.set(0, -Math.sin(curlAngle), Math.cos(curlAngle));
  s.dirEnd.set(0, -Math.sin(refAngle), Math.cos(refAngle));
  const sweep = s.dirStart.angleTo(s.dirEnd);
  s.axis.crossVectors(s.dirStart, s.dirEnd);
  if (s.axis.lengthSq() < 1e-10) s.axis.set(1, 0, 0); else s.axis.normalize();
  const arcLen = Math.min(radius * sweep, totalLength);
  const straightLen = Math.max(0, totalLength - arcLen);
  s.radialStart.crossVectors(s.dirStart, s.axis);
  s.radialEnd.copy(s.radialStart).applyAxisAngle(s.axis, sweep);
  out.copy(s.radialEnd).sub(s.radialStart).multiplyScalar(radius).add(anchorPoint);
  s.tmp.copy(s.dirEnd).multiplyScalar(straightLen);
  return out.add(s.tmp);
}

/**
 * Closest distance from a world point to a page treated as a finite oriented
 * box: hinged at `anchor`, currently at `angle`, spanning [0, panelReach]
 * away from its hinge, [-hingeLen/2, hingeLen/2] across, [-thick/2, thick/2]
 * through. Standard point-to-box distance: project into the box's frame,
 * clamp each axis to its extent, measure from there.
 */
const _distCalc = { T: new THREE.Vector3(), N: new THREE.Vector3(), v: new THREE.Vector3(), closest: new THREE.Vector3() };
export function closestDistanceToPage(point, anchor, angle, hingeLen, panelReach, thick) {
  const s = _distCalc;
  s.T.set(0, -Math.sin(angle), Math.cos(angle)); // the page's "reach" axis
  s.N.set(0, -Math.cos(angle), -Math.sin(angle)); // (1,0,0) x T — the thickness axis
  s.v.copy(point).sub(anchor);
  const a = clampNum(s.v.x, -hingeLen / 2, hingeLen / 2);
  const b = clampNum(s.v.dot(s.T), 0, panelReach);
  const c = clampNum(s.v.dot(s.N), -thick / 2, thick / 2);
  s.closest.copy(anchor).addScaledVector(AXIS_X, a).addScaledVector(s.T, b).addScaledVector(s.N, c);
  return point.distanceTo(s.closest);
}