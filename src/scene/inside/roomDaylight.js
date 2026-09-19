import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { sunAt, TIME_RANGE } from '../outside/sunPath.js';
import { sunShade, overcastFor } from '../outside/outdoorLight.js';

/**
 * The daylight in the room: the same sun and the same sky as outside, coming
 * in only where the windows let them.
 *
 * THE SUN. One directional light, where the outdoor sun is at the time of day
 * set (scene/outside/sunPath.js) and coloured and dimmed the way it is out
 * there (outdoorLight.js's sunShade) -- warm and low in the morning and
 * evening, cut by an overcast. It casts, and so do the walls, the ceiling, the
 * door and the window frames (scene/inside/room.js): sunlight gets in only
 * through the glass, as patches the shape of the arches with the glazing bars
 * across them, and they move across the floor as the time of day does. At
 * some times of day the sun is simply round the other side of the building
 * and none comes in -- which is what a real room does.
 *
 * Its shadow camera is fitted to the whole room -- both storeys -- as the sun
 * sees it, whenever the sun moves: every texel of the map on the room, and
 * nothing redrawn while it stays put.
 *
 * ONLY WHEN IT CAN GET IN. When the sun is round the side of the building no
 * window faces -- most of the afternoon and evening, the way this room stands
 * -- or down, the walls would shadow every bit of it anyway. Then it is simply
 * off, and its shadow map is not drawn at all: that is a whole pass over the
 * room saved every frame, and the sunbeams (roomBeams.js) go with it. With the
 * walls hidden (the H key) there is nothing to keep it out, and it is on
 * whenever it is up.
 *
 * THE SKY. What a window mostly lets in is not the sun but the sky: soft light
 * from a bright rectangle, strongest right in front of it. Each row of windows
 * is one area light (THREE.RectAreaLight) the size of its opening, shining
 * inward -- the sky's blue on a clear day, grey under an overcast, fading
 * toward dusk. Area lights cast no shadows, but they light only what is in
 * front of them, so nothing outside the room is lit through a wall.
 *
 * WHERE THE NUMBERS LIVE. ROOM_DAYLIGHT is mutable, for the debug overlay
 * (debug/mezzaninePanel.js's Daylight section); refresh() applies it.
 */

export const ROOM_DAYLIGHT = {
  sun: 8, // the sun's strength through the glass at full height, clear sky
  sky: 1.2, // each window row's sky light, luminance at full day
  skyColour: 0xcfe0ff, // the sky on a clear day
  overcastColour: 0xe4e7ec, // and under an overcast
  // The sunbeams and the dust in them (scene/inside/roomBeams.js).
  beamStrength: 0.002, // how much light a metre of sunlit air sends back
  beamForward: 0.31, // how much brighter it looks toward the sun (0 the same any way)
  dustBrightness: 0.09,
  dustSize: 0.007, // metres, a speck at its largest
};

// The sky brightens as the sun climbs: this share of its full light at the
// horizon, all of it from SKY_FULL_FROM degrees up. Gone below SKY_DARK.
const SKY_LOW_SHARE = 0.45;
const SKY_FULL_FROM = 35;
const SKY_DARK = -6;
const UP = new THREE.Vector3(0, 1, 0);
// The area lights sit this far in from the glass, so the plane they light from
// is not the plane of the wall around them.
const SKY_INSET = 0.02;
const SHADOW_MARGIN = 0.3; // metres the sun's shadow camera takes in past the room
// How far round to a window's side the sun has to be to come in at it: the
// cosine between the sun and the way the window faces out.
const FACING = 0.02;

let uniformsReady = false;

/**
 * @param {object} opts
 * @param {THREE.Object3D} opts.group  what to hang the lights on -- the room's
 *   own group, so they go dark with it outside
 * @param {THREE.Box3} opts.box  the whole room, both storeys, in world space
 * @param {Array<{ centre: THREE.Vector3, inward: [number, number], width: number,
 *   sill: number, head: number, light?: number }>} opts.windows  each row of
 *   windows: the middle of its glass, which way is into the room, its size, and
 *   its share of the sky's light (0 for none)
 * @param {() => number} opts.hours  the time of day (settings.outside.timeOfDay)
 * @param {() => number} opts.coverage  how much of the sky the clouds cover, 0..1
 * @param {() => boolean} [opts.enclosed]  whether the walls are up (the H key)
 * @returns {{ sun: THREE.DirectionalLight, skies: THREE.RectAreaLight[],
 *   refresh(): void, dispose(): void }}
 */
export function addRoomDaylight({ group, box, windows, hours, coverage, enclosed = () => true }) {
  if (!uniformsReady) {
    RectAreaLightUniformsLib.init();
    uniformsReady = true;
  }

  const centre = box.getCenter(new THREE.Vector3());
  const room = box.clone().expandByScalar(SHADOW_MARGIN);
  const radius = room.getSize(new THREE.Vector3()).length() / 2;
  const distance = radius + 2;
  // The room's corners, for fitting the shadow camera to them.
  const corners = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(
    i & 1 ? room.max.x : room.min.x,
    i & 2 ? room.max.y : room.min.y,
    i & 4 ? room.max.z : room.min.z,
  ));

  // --- the sun ---------------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffffff, 0);
  // 'daylight', so the graphics quality sizes its shadow map as the window's
  // (ui/bindSettings.js's applyShadowQuality).
  sun.name = 'daylight';
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const shadowCamera = sun.shadow.camera;
  // normalBias rather than a flat bias: it scales the offset by how glancing
  // the surface is, which is what stops acne on the walls without lifting a
  // book's shadow off the desk.
  sun.shadow.normalBias = 0.02;
  sun.target.position.copy(centre);
  group.add(sun, sun.target);

  // --- the sky, one area light a row --------------------------------------------------
  const skies = windows
    .filter((row) => (row.light ?? 1) > 0)
    .map((row) => {
      const light = new THREE.RectAreaLight(0xffffff, 0, row.width, row.head - row.sill);
      light.name = 'windowSky';
      const [ix, iz] = row.inward;
      light.position.copy(row.centre).add(new THREE.Vector3(ix, 0, iz).multiplyScalar(SKY_INSET));
      // A light's lookAt turns its face -- the side it shines from -- to the point.
      light.lookAt(light.position.x + ix, light.position.y, light.position.z + iz);
      light.userData.share = row.light ?? 1;
      group.add(light);
      return light;
    });

  const _direction = new THREE.Vector3();
  const _clear = new THREE.Color();
  const _overcast = new THREE.Color();
  const _view = new THREE.Matrix4();
  const _corner = new THREE.Vector3();

  /** Fit the shadow camera round the room, as seen from where the sun now is. */
  function fitShadow() {
    // The view the shadow camera will have: from the sun, at the room's middle.
    _view.lookAt(sun.position, centre, UP).setPosition(sun.position).invert();
    let left = Infinity; let right = -Infinity;
    let bottom = Infinity; let top = -Infinity;
    let near = Infinity; let far = -Infinity;
    for (const corner of corners) {
      _corner.copy(corner).applyMatrix4(_view);
      left = Math.min(left, _corner.x); right = Math.max(right, _corner.x);
      bottom = Math.min(bottom, _corner.y); top = Math.max(top, _corner.y);
      near = Math.min(near, -_corner.z); far = Math.max(far, -_corner.z);
    }
    Object.assign(shadowCamera, { left, right, bottom, top, near: Math.max(0.1, near), far });
    shadowCamera.updateProjectionMatrix();
  }

  /** Can the sun get into the room at all -- is it round the side of any window? */
  function reachesIn() {
    if (!enclosed()) return true;
    return windows.some(({ inward: [ix, iz] }) => -(ix * _direction.x + iz * _direction.z) > FACING);
  }

  function refresh() {
    const time = THREE.MathUtils.clamp(hours(), TIME_RANGE[0], TIME_RANGE[1]);
    const { elevation, azimuth } = sunAt(time);
    const overcast = overcastFor(coverage());

    // Where outdoorLight.js's sun is, the same way round.
    _direction.setFromSphericalCoords(
      1, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(azimuth),
    );
    sun.position.copy(centre).addScaledVector(_direction, distance);
    const strength = ROOM_DAYLIGHT.sun * sunShade(elevation, overcast, sun.color);
    sun.intensity = strength > 0.001 && reachesIn() ? strength : 0;
    // Its shadow map drawn only while it lights anything -- not left at 0
    // intensity with castShadow off, which would change every material's
    // program and stall the frame recompiling them.
    const shining = sun.intensity > 0;
    if (shining && !sun.shadow.autoUpdate) sun.shadow.needsUpdate = true;
    sun.shadow.autoUpdate = shining;
    sun.updateMatrixWorld();
    fitShadow();

    const day = THREE.MathUtils.smoothstep(elevation, SKY_DARK, 0)
      * THREE.MathUtils.lerp(SKY_LOW_SHARE, 1, THREE.MathUtils.smoothstep(elevation, 0, SKY_FULL_FROM));
    _clear.set(ROOM_DAYLIGHT.skyColour);
    _overcast.set(ROOM_DAYLIGHT.overcastColour);
    for (const sky of skies) {
      sky.color.copy(_clear).lerp(_overcast, overcast);
      sky.intensity = ROOM_DAYLIGHT.sky * day * sky.userData.share;
    }
  }
  refresh();

  return {
    sun,
    skies,
    /** Take the time of day, the clouds and ROOM_DAYLIGHT again. */
    refresh,
    dispose() {
      group.remove(sun, sun.target, ...skies);
      sun.dispose();
      for (const sky of skies) sky.dispose();
    },
  };
}
