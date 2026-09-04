import * as THREE from 'three';
import { CURL_ROWS } from './curlGeometry.js';

/**
 * Wedge geometry.
 *
 * The wedge fills the gap between the flat reference page's straight edge
 * (pivot to tip) and the curling page's ACTUAL bent edge. It's a direct
 * loft: for each of WEDGE_ROWS "rungs" it connects a point on the flat
 * page's straight edge to the curl's own point at the SAME fraction of
 * their shared PANEL_REACH length — so the far edge of the wedge always
 * lands exactly on the curl's real tip, and the surface hugs the curve in
 * between rather than cutting through it.
 */

export const WEDGE_ROWS = CURL_ROWS;

export const WEDGE_INDEX = (() => {
  const idx = [];
  const n = WEDGE_ROWS;
  const flatL = (i) => i;
  const curlL = (i) => n + i;
  const flatR = (i) => 2 * n + i;
  const curlR = (i) => 3 * n + i;
  for (let i = 0; i < WEDGE_ROWS - 1; i++) {
    idx.push(flatL(i), flatL(i + 1), curlL(i + 1));
    idx.push(flatL(i), curlL(i + 1), curlL(i));
    idx.push(flatR(i), curlR(i + 1), flatR(i + 1));
    idx.push(flatR(i), curlR(i), curlR(i + 1));
    idx.push(flatL(i), flatR(i), flatR(i + 1));
    idx.push(flatL(i), flatR(i + 1), flatL(i + 1));
    idx.push(curlL(i), curlR(i + 1), curlR(i));
    idx.push(curlL(i), curlL(i + 1), curlR(i + 1));
  }
  // End caps close the flat<->curl gap at the spine (row 0) and tip
  // (row n-1) ends.
  idx.push(flatL(0), curlL(0), curlR(0));
  idx.push(flatL(0), curlR(0), flatR(0));
  idx.push(flatL(n - 1), flatR(n - 1), curlR(n - 1));
  idx.push(flatL(n - 1), curlR(n - 1), curlL(n - 1));
  return idx;
})();

/**
 * Fills one side (L or R) of the wedge: WEDGE_ROWS pairs of (flat, curl)
 * vertices, where row i's flat-side point sits `curlRowFrac[i]` of the way
 * from `flatPivot` to `flatTip` — the same fraction of PANEL_REACH the
 * curl's own row i has actually travelled. `curlPosArray` / `curlColStart`
 * read straight out of the curl mesh's position buffer, so this always
 * matches the rendered curve exactly.
 */
const _wedgeFill = { flatPoint: new THREE.Vector3() };
export function fillWedgeSide(flatPivot, flatTip, curlPosArray, curlColStart, curlRowFrac, positions, flatOffset, curlOffset) {
  for (let i = 0; i < WEDGE_ROWS; i++) {
    const flatPoint = _wedgeFill.flatPoint.copy(flatPivot).lerp(flatTip, curlRowFrac[i]);
    const fi = (flatOffset + i) * 3;
    positions[fi] = flatPoint.x; positions[fi + 1] = flatPoint.y; positions[fi + 2] = flatPoint.z;

    const ci = (curlColStart + i) * 3;
    const oi = (curlOffset + i) * 3;
    positions[oi] = curlPosArray[ci]; positions[oi + 1] = curlPosArray[ci + 1]; positions[oi + 2] = curlPosArray[ci + 2];
  }
}
