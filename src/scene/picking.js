import * as THREE from 'three';

/**
 * Picking: turning where the pointer is into what is under it.
 *
 * Every click and hover in the app goes the same way -- the pointer's place on
 * the canvas as normalised device coordinates, a ray from the camera through
 * it, and the nearest thing it meets that is actually being DRAWN. That used
 * to be written out again in each place that needed it (the door, the shelf,
 * the wall shelves, the sofa, the instruction card, the book in hand, the
 * seats outside), each copy with its own chance to get a sign or a rect wrong.
 * It is here once.
 *
 * WHY "DRAWN" AND NOT JUST "HIT". three's raycaster ignores `visible`: it will
 * happily hit the walls you have switched off, a shelf book whose real book is
 * in your hand, or the whole room while you are standing outside. So a hit
 * only counts if the object AND every one of its ancestors is visible --
 * hiding a group hides everything in it, and raycasting has to agree.
 */

const _ndc = new THREE.Vector2();

/**
 * Whether an object is actually drawn: it and every one of its ancestors
 * visible.
 *
 * @param {THREE.Object3D|null|undefined} object
 */
export function isShown(object) {
  if (!object) return false;
  for (let node = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

/**
 * A pointer position as normalised device coordinates over an element: -1 at
 * its left and bottom edges, +1 at its right and top.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @param {Element} dom  the canvas, usually
 * @param {THREE.Vector2} [out]
 * @returns {THREE.Vector2} `out`
 */
export function pointerToNdc(clientX, clientY, dom, out = new THREE.Vector2()) {
  const rect = dom.getBoundingClientRect();
  return out.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
}

/**
 * Point a raycaster from the camera through where the pointer is.
 *
 * @param {THREE.Raycaster} raycaster
 * @param {number} clientX
 * @param {number} clientY
 * @param {THREE.Camera} camera
 * @param {Element} dom
 * @returns {THREE.Raycaster} `raycaster`, aimed
 */
export function aimAtPointer(raycaster, clientX, clientY, camera, dom) {
  raycaster.setFromCamera(pointerToNdc(clientX, clientY, dom, _ndc), camera);
  return raycaster;
}

/**
 * The nearest hit on anything drawn, among `targets` and everything under
 * them -- so something in front keeps the click, and something hidden does not.
 *
 * @param {THREE.Raycaster} raycaster  already aimed
 * @param {THREE.Object3D|THREE.Object3D[]} targets
 * @returns {THREE.Intersection|undefined}
 */
export function nearestShownHit(raycaster, targets) {
  const hits = Array.isArray(targets)
    ? raycaster.intersectObjects(targets.filter(Boolean), true)
    : raycaster.intersectObject(targets, true);
  return hits.find((hit) => isShown(hit.object));
}

/**
 * Whether `object` is `ancestor` or somewhere under it.
 *
 * @param {THREE.Object3D|null|undefined} object
 * @param {THREE.Object3D} ancestor
 */
export function isWithin(object, ancestor) {
  for (let node = object; node; node = node.parent) if (node === ancestor) return true;
  return false;
}

/**
 * Keep track of where the pointer is over a canvas, for hover tests run every
 * frame: `ndc` its normalised position, `inside` whether it is over the canvas
 * at all.
 *
 * On the WINDOW for moves, not the canvas: a pointer that leaves over one of
 * the interface panels laid over the canvas never fires the canvas's own leave
 * -- but it does keep moving, and a hover that stuck on would leave a book
 * drawn out of its shelf.
 *
 * @param {Element} dom
 * @returns {{ ndc: THREE.Vector2, inside: boolean, dispose(): void }}
 */
export function trackPointer(dom) {
  const pointer = {
    ndc: new THREE.Vector2(),
    inside: false,
    dispose() {
      window.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerleave', onLeave);
    },
  };
  const onMove = (event) => {
    pointerToNdc(event.clientX, event.clientY, dom, pointer.ndc);
    pointer.inside = true;
  };
  const onLeave = () => { pointer.inside = false; };
  window.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerleave', onLeave);
  return pointer;
}
