import * as THREE from 'three';
import { OPEN_LIMIT } from '../pageSim/config.js';
import { spineHinge } from '../pageSim/math.js';

/**
 * Drag a hardcover board to swing the book open or shut.
 *
 * This is a different mechanism from dragPageTurn, not a variation on it.
 * A page turn bends a throwaway leaf between two curl shapes and never
 * touches physics; H1 and H2 are independent render-only boards. Dragging
 * one updates its own angle rather than any page or pseudo-body angle.
 *
 * The hold is applied by PageSimulation inside its own correction
 * pipeline (setHardcoverHold), not from out here, so it lands in the right
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
 *
 * SPREADS. A book whose board has been opened but whose leaves have not
 * come with it (PageSimulation.openState needs 'spread') has every page
 * lying in one pile past the spine, and a page turn across it would sweep
 * from that side to that same side and show nothing. So while that is the
 * state, a press on ANY page is taken as lifting that half of the block:
 * the same angular sweep a board gets, driving the spread's pseudo body
 * through setSpreadHold instead of a board through setHardcoverHold. The
 * reference page is sandwiched against the pseudo body and comes along.
 * Which page was hit does not matter -- they are all in the one pile, and
 * the half that has to move is fixed by which way the book was shut.
 * Let go past upright and gravity lays it down on the board; short of
 * that and it falls back, exactly as a board does.
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
  const SWEEP_SIGN = { H1: 1, H2: 1 };

  const _anchorLocal = new THREE.Vector3();
  const _anchorWorld = new THREE.Vector3();
  const pivotScreen = new THREE.Vector2();

  let slot = null; // 'H1' | 'H2' while dragging a board
  let spread = null; // 'front' | 'back' while lifting a spread
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
      [hc?.H1, 'H1'], [hc?.H2, 'H2'],
      [pages.pageMeshes.A, 'A'], [pages.pageMeshes.D, 'D'],
      [pages.pageMeshes.B, 'B'], [pages.pageMeshes.C, 'C'],
    ]);
    const targets = [...bySlot.keys()].filter((m) => m && m.visible);
    const hits = raycaster.intersectObjects(targets, false);
    return hits.length ? bySlot.get(hits[0].object) ?? null : null;
  }

  /** Screen-space pivot for a sweep about the book-local point (0, y, z). */
  function pivotAt(pages, y, z, e) {
    _anchorLocal.set(0, y, z);
    _anchorWorld.copy(_anchorLocal).applyMatrix4(pages.root.matrixWorld);
    screenPointFor(_anchorWorld, pivotScreen);
    angle0 = Math.atan2(e.clientY - pivotScreen.y, e.clientX - pivotScreen.x);
  }

  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || slot || spread || e.shiftKey) return; // shift is the book-slide gesture
    const pages = getPages();
    if (!pages) return;

    const hit = pickSlot(pages, e.clientX, e.clientY);
    if (!hit) return;

    if (hit === 'H1' || hit === 'H2') {
      pivotAt(pages, 0, pages.hardcoverHingeZ(hit), e);
      slot = hit;
      startAngle = pages.hardcoverAngles[hit];
      pages.setHardcoverHold(hit, startAngle);
    } else {
      // A page. Only ours while a spread is waiting to be lifted; any other
      // time a page press belongs to dragPageTurn.
      const state = pages.openState;
      if (state.needs !== 'spread') return;
      const lifted = state.side === 'front' ? pages.spreadFront : pages.spreadBack;
      // The spread's own hinge, wherever SPINE_ROTATION has put it -- a
      // shut book's spine is tilted right over, so the flat anchor would
      // put the pivot somewhere the pages are not hinged.
      const hinge = spineHinge(lifted.refAnchor.z).mid;
      pivotAt(pages, hinge.y, hinge.z, e);
      spread = state.side;
      const { P1, P2 } = pages.panelAngles;
      startAngle = spread === 'front' ? P1 : P2;
      pages.setSpreadHold(spread, startAngle);
    }

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
    if (!slot && !spread) return;
    const pages = getPages();
    if (!pages) return;
    const angle = Math.atan2(e.clientY - pivotScreen.y, e.clientX - pivotScreen.x);
    let delta = angle - angle0;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest signed difference
    // A spread lies on its board's side of the spine and shares its angle
    // convention, so it sweeps the way that board does.
    const board = slot ?? (spread === 'front' ? 'H1' : 'H2');
    const target = THREE.MathUtils.clamp(
      startAngle + SWEEP_SIGN[board] * delta * COVER_SENSITIVITY, 0, OPEN_LIMIT,
    );
    if (slot) pages.setHardcoverHold(slot, target);
    else pages.setSpreadHold(spread, target);
  });

  function release() {
    if (!slot && !spread) return;
    // Hand the board or spread back to gravity from exactly where it was
    // let go -- no snap to either end. It falls open or swings back on its
    // own.
    if (slot) getPages()?.setHardcoverHold(slot, null);
    else getPages()?.setSpreadHold(spread, null);
    slot = null;
    spread = null;
    controls.enabled = true;
    dom.style.cursor = '';
  }

  window.addEventListener('pointerup', (e) => { if (e.button === 0) release(); });
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);

  return {
    get draggingCover() { return slot; },
    get draggingSpread() { return spread; },
    release,
  };
}
