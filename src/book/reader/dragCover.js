import * as THREE from 'three';
import { OPEN_LIMIT } from '../pageSim/config.js';

/**
 * Drag a hardcover board to swing the book open or shut.
 *
 * This is a different mechanism from dragPageTurn, not a variation on it.
 * A page turn bends a throwaway leaf between two curl shapes and never
 * touches physics; a cover is a real simulated body (A is the front
 * spread's near page, D the back spread's far one) hinged on a revolute
 * joint and pulled by gravity. So dragging one just dictates its angle
 * for the length of the gesture and hands it straight back to gravity on
 * release -- the cover falls open or swings shut from wherever it was let
 * go, rather than snapping to either end.
 *
 * The hold is applied by PageSimulation inside its own correction
 * pipeline (setCoverHold), not from out here, so it lands in the right
 * order relative to everything else -- notably before enforceNoPassingRef,
 * which still stops a cover being dragged down through the page block.
 *
 * PICKING. The hit test deliberately raycasts the pages as well as the
 * covers even though it only ever claims a cover. Testing the covers
 * alone would let a click that really landed on a page be claimed by
 * whichever cover happens to lie behind it along the same ray. Taking the
 * nearest hit of ALL of them and bailing unless it is a cover is what
 * keeps this and dragPageTurn from fighting over the same gesture -- this
 * one is registered first, so it gets to look before dragPageTurn does,
 * and only swallows the event when the cover genuinely is the front-most
 * thing under the cursor.
 */
export function createDragCover({ getPages, camera, renderer, controls }) {
  const dom = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  // 1 = the cover tracks the cursor's own angular sweep around the hinge.
  // Covers are big and grabbed near their edge, so a direct mapping reads
  // as actually holding the board rather than nudging it.
  const COVER_SENSITIVITY = 1.0;

  // Which way a screen-space sweep rotates each cover. A and D hinge on
  // the same axis with the same angle convention but extend to opposite
  // sides of the spine, so the same drag has to turn them opposite ways --
  // the same split dragPageTurn makes between B and C. Flip both together
  // if the whole book ever reads mirrored.
  const SWEEP_SIGN = { A: 1, D: -1 };

  const _anchorLocal = new THREE.Vector3();
  const _anchorWorld = new THREE.Vector3();
  const pivotScreen = new THREE.Vector2();

  let slot = null; // 'A' | 'D' while dragging
  let angle0 = 0; // cursor angle at grab
  let startAngle = 0; // the cover's own angle at grab

  function screenPointFor(worldPoint, out) {
    const ndc = worldPoint.clone().project(camera);
    const rect = dom.getBoundingClientRect();
    out.set(
      rect.left + (ndc.x * 0.5 + 0.5) * rect.width,
      rect.top + (1 - (ndc.y * 0.5 + 0.5)) * rect.height,
    );
    return out;
  }

  /**
   * Nearest surface under the cursor, as a slot name, or null. Returns
   * 'B'/'C' too so the caller can tell "a page is in front" from "nothing
   * was hit" and decline the gesture in both cases.
   */
  function pickSlot(pages, clientX, clientY) {
    const rect = dom.getBoundingClientRect();
    pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);

    // Boards first in the list is irrelevant -- intersectObjects sorts by
    // distance -- but they must be IN it: they are what is actually
    // visible, the cover pages being tucked underneath them.
    const hc = pages.hardcover;
    const bySlot = new Map([
      [hc?.frontBoard, 'A'], [hc?.backBoard, 'D'],
      [pages.pageMeshes.A, 'A'], [pages.pageMeshes.D, 'D'],
      [pages.pageMeshes.B, 'B'], [pages.pageMeshes.C, 'C'],
    ]);
    const targets = [...bySlot.keys()].filter((m) => m && m.visible);
    const hits = raycaster.intersectObjects(targets, false);
    return hits.length ? bySlot.get(hits[0].object) ?? null : null;
  }

  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || slot || e.shiftKey) return; // shift is the book-slide gesture
    const pages = getPages();
    if (!pages) return;

    const hit = pickSlot(pages, e.clientX, e.clientY);
    if (hit !== 'A' && hit !== 'D') return; // a page, or nothing -- not ours

    _anchorLocal.set(0, 0, pages.coverHingeZ(hit));
    _anchorWorld.copy(_anchorLocal).applyMatrix4(pages.root.matrixWorld);
    screenPointFor(_anchorWorld, pivotScreen);

    slot = hit;
    angle0 = Math.atan2(e.clientY - pivotScreen.y, e.clientX - pivotScreen.x);
    startAngle = pages.coverAngles[hit];
    pages.setCoverHold(hit, startAngle);

    controls.enabled = false;
    dom.style.cursor = 'grabbing';
    // Registered ahead of dragPageTurn's own capture listener, so stopping
    // the event here is what keeps a cover grab from also starting a page
    // turn on whatever sits behind it.
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
  }, { capture: true });

  window.addEventListener('pointermove', (e) => {
    if (!slot) return;
    const pages = getPages();
    if (!pages) return;
    const angle = Math.atan2(e.clientY - pivotScreen.y, e.clientX - pivotScreen.x);
    let delta = angle - angle0;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest signed difference
    const target = startAngle + SWEEP_SIGN[slot] * delta * COVER_SENSITIVITY;
    pages.setCoverHold(slot, THREE.MathUtils.clamp(target, 0, OPEN_LIMIT));
  });

  function release() {
    if (!slot) return;
    // Hand the cover back to gravity from exactly where it was let go --
    // no snap to either end. It falls open or swings shut on its own.
    getPages()?.setCoverHold(slot, null);
    slot = null;
    controls.enabled = true;
    dom.style.cursor = '';
  }

  window.addEventListener('pointerup', (e) => { if (e.button === 0) release(); });
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);

  return {
    get draggingCover() { return slot; },
    release,
  };
}
