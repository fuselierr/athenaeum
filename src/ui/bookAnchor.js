import * as THREE from 'three';
import { bookControls } from '../state/bookControls.js';

/**
 * Where the book is on the screen, for the card held over it
 * (ui/BookControls.vue).
 *
 * THROUGH CSS, NOT THROUGH VUE. The book moves every frame -- it is carried,
 * turned, walked around -- and pushing its position into a reactive store
 * would wake Vue sixty times a second to move one panel. So the place is
 * written as custom properties on the document (--ath-book-x / --ath-book-y)
 * and the card positions itself from them: the frame loop touches a style,
 * the component never re-renders, and the two stay in step because the
 * browser does the work.
 *
 * ONLY ON A CHANGE. Both the properties and `onScreen` are written only when
 * they actually differ -- rounded to the pixel, which is as fine as a panel
 * can be placed anyway -- so a book sitting still on the desk costs nothing
 * at all. The same care main.js takes over bookState.page, for the same
 * reason.
 *
 * WHAT IT POINTS AT is the focused book's own origin, not the middle of its
 * bounding box: the box would mean walking every page's geometry each frame,
 * and the card is offset upward in the stylesheet regardless -- it hangs
 * ABOVE the book, so that what the controls describe is not hidden behind
 * the description of it.
 */

// Rounded to this many pixels before anything is written. A panel cannot be
// placed finer, and it keeps a book that is only trembling from writing
// styles every frame.
const STEP = 1;

/**
 * @param {object} opts
 * @param {THREE.Camera} opts.camera
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {() => THREE.Object3D|null} opts.getGroup  the book in focus
 * @returns {{ update(): void }}  call once a frame, after the camera has moved
 */
export function createBookAnchor({ camera, renderer, getGroup }) {
  const style = document.documentElement.style;
  const _at = new THREE.Vector3();
  let lastX = null;
  let lastY = null;

  function place(x, y) {
    if (x !== lastX) {
      lastX = x;
      style.setProperty('--ath-book-x', `${x}px`);
    }
    if (y !== lastY) {
      lastY = y;
      style.setProperty('--ath-book-y', `${y}px`);
    }
  }

  return {
    update() {
      // Nothing is asking where the book is: not even the projection is worth
      // doing while the card is down.
      if (!bookControls.showing) {
        if (bookControls.onScreen) bookControls.onScreen = false;
        return;
      }

      const group = getGroup();
      if (!group) {
        if (bookControls.onScreen) bookControls.onScreen = false;
        return;
      }

      _at.setFromMatrixPosition(group.matrixWorld).project(camera);
      // Past the far plane in clip space means behind the camera -- the
      // projection still gives an x and a y there, mirrored, and following
      // them would sit the card over empty room.
      const ahead = _at.z < 1;
      if (bookControls.onScreen !== ahead) bookControls.onScreen = ahead;
      if (!ahead) return;

      const dom = renderer.domElement;
      place(
        Math.round(((_at.x * 0.5 + 0.5) * dom.clientWidth) / STEP) * STEP,
        Math.round(((-_at.y * 0.5 + 0.5) * dom.clientHeight) / STEP) * STEP,
      );
    },
  };
}
