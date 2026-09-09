import * as THREE from 'three';

// World units/sec at ~4 units from the target; scales with distance below.
const PAN_SPEED = 1.4;
const CAMERA_MOVE_SPEED = 5;
const CAMERA_MOVE_ACCELERATION = 15;
const CAMERA_MOVE_DAMPING = 8;

/**
 * WASD camera panning. Takes over the job right-drag used to do on
 * OrbitControls (see `controls.mouseButtons.RIGHT = null` in
 * scene/createScene.js) -- moves camera.position and controls.target
 * together along the camera's own local right/up axes, the same math
 * OrbitControls' internal pan uses, just driven by held keys instead of a
 * drag delta.
 *
 * Returns `{ update(dt) }` for the render loop to tick.
 */
export function createCameraPan({ camera, controls }) {
  const held = new Set();

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'arrowup' || k === 'arrowdown') {
      held.add(k);
    }
  });
  window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
  // Without this a key held while the window loses focus never gets its
  // keyup, and the camera drifts forever after the user tabs back.
  window.addEventListener('blur', () => held.clear());

  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _offset = new THREE.Vector3();
  const _forward = new THREE.Vector3();
  let forwardVelocity = 0;

  return {
    update(dt) {
      const distance = camera.position.distanceTo(controls.target);
      const speed = PAN_SPEED * (distance / 4) * dt;
      const forwardInput = (held.has('arrowup') ? 1 : 0) - (held.has('arrowdown') ? 1 : 0);
      const targetVelocity = forwardInput * CAMERA_MOVE_SPEED * (distance / 4);
      const response = forwardInput === 0 ? CAMERA_MOVE_DAMPING : CAMERA_MOVE_ACCELERATION;
      forwardVelocity = THREE.MathUtils.damp(forwardVelocity, targetVelocity, response, dt);

      _right.setFromMatrixColumn(camera.matrix, 0);
      _up.setFromMatrixColumn(camera.matrix, 1);
      _forward.subVectors(controls.target, camera.position).normalize();
      _offset.set(0, 0, 0);
      if (held.has('d')) _offset.addScaledVector(_right, speed);
      if (held.has('a')) _offset.addScaledVector(_right, -speed);
      if (held.has('w')) _offset.addScaledVector(_up, speed);
      if (held.has('s')) _offset.addScaledVector(_up, -speed);
      _offset.addScaledVector(_forward, forwardVelocity * dt);

      camera.position.add(_offset);
      controls.target.add(_offset);
    },
  };
}
