import * as THREE from 'three';

/**
 * Which way you are looking, for the debug overlay (the ` key): just above the
 * frame counter, bottom right.
 *
 *   look   the direction you face along the ground, as x and z. Flattened and
 *          normalised, so it is the heading rather than the view ray: looking
 *          at your feet still says which way you are facing.
 *   yaw    that same heading in degrees, measured the way the rest of the
 *          scene measures one -- 0 along -Z, turning toward +X -- so a number
 *          read off here can be written straight into a `facing` or a
 *          rotation.y (scene/outside/parkBench.js, scene/inside/sofa.js).
 *   at     where you are standing, x and z, for placing anything by eye and
 *          then writing down where it went.
 *
 * Written every frame while it shows, which is a DOM write a frame -- fine for
 * something only up with the overlay, and the point of it is to follow you as
 * you move.
 */

const UP_IS_Y = new THREE.Vector3();

/** Signed and to two places, with room for the minus so the column cannot jump. */
const fixed = (value) => (value < 0 ? '' : ' ') + value.toFixed(2);

export function createFacingPanel({ camera }) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed',
    right: '12px',
    bottom: '78px', // clear of the frame counter under it
    zIndex: '10000',
    pointerEvents: 'none',
    font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: '#e8e8e8',
    background: 'rgba(12, 14, 20, 0.82)',
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(255, 255, 255, 0.14)',
    whiteSpace: 'pre',
    display: 'none',
    userSelect: 'none',
  });
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);

  const _direction = new THREE.Vector3();
  const _position = new THREE.Vector3();

  return {
    /** Call once a frame, with whether the debug overlay is up. */
    update(visible) {
      el.style.display = visible ? 'block' : 'none';
      if (!visible) return;

      // World, not local: in VR the camera rides the rig (input/vrControls.js),
      // and its own position and rotation are the head's within that rig.
      camera.getWorldDirection(_direction);
      camera.getWorldPosition(_position);
      _direction.y = 0;
      // Straight up or down: no heading to be had, so the last one is kept.
      if (_direction.lengthSq() > 1e-8) {
        _direction.normalize();
        UP_IS_Y.copy(_direction);
      }
      const heading = THREE.MathUtils.radToDeg(Math.atan2(-UP_IS_Y.x, -UP_IS_Y.z));

      el.textContent = `look  x ${fixed(UP_IS_Y.x)}  z ${fixed(UP_IS_Y.z)}\n`
        + `yaw   ${heading.toFixed(0).padStart(4)}°  (0 = -Z)\n`
        + `at    x ${fixed(_position.x)}  z ${fixed(_position.z)}`;
    },

    dispose() {
      el.remove();
    },
  };
}
