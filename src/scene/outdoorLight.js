import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * Daylight outside: the three pieces an Unreal outdoor level starts from.
 *
 *   SKY ATMOSPHERE   three's Sky -- the Preetham analytic daylight model: a
 *                    box drawn behind everything, coloured by how sunlight
 *                    scatters through the air for a given sun position.
 *                    Blue overhead, pale at the horizon, warm near the sun.
 *
 *   DIRECTIONAL LIGHT  the sun. Parallel rays from the same direction the
 *                    sky puts its sun disc, casting the terrain's shadows.
 *
 *   SKY LIGHT        the light the sky itself gives off, which is what
 *                    reaches the ground in shadow. Unreal's Sky Light
 *                    captures the sky into a cubemap and lights with it; this
 *                    does the same -- the Sky is rendered once into a
 *                    prefiltered environment map (PMREMGenerator) that
 *                    becomes scene.environment, so shadowed slopes take the
 *                    sky's blue instead of going black.
 *
 * TONE MAPPING. The sky model outputs real daylight brightness, far past
 * what a screen shows. Without tone mapping the sky and anything in sun
 * clip to white, so going outside also switches on ACES filmic. Exposure is
 * not set here: the post-processing chain meters and adapts it
 * (scene/outdoorPost.js), so the renderer's own exposure stays at 1.
 */

// Where the sun is, in degrees: elevation above the horizon, and azimuth
// clockwise from +Z seen from above.
const SUN_ELEVATION = 35;
const SUN_AZIMUTH = 200;
const SUN_COLOR = 0xfff1e0;
const SUN_INTENSITY = 3;

// The atmosphere. Turbidity is haze (2 very clear, 10 hazy); rayleigh is
// the blue of clean air; the Mie terms are the glow around the sun.
const ATMOSPHERE = {
  turbidity: 6,
  rayleigh: 1.4,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
};

// How strongly the captured sky lights the scene.
const SKY_LIGHT_INTENSITY = 1;

/**
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {THREE.Vector3} opts.centre  the middle of the ground being lit
 * @param {number} opts.reach  half the width of that ground, metres -- what
 *   the sun's shadows have to cover
 * @returns {{ sky: Sky, sun: THREE.DirectionalLight, sunDirection: THREE.Vector3,
 *   skyTexture: THREE.CubeTexture,
 *   sunAngles: { elevation: number, azimuth: number },
 *   setSunAngles(elevation: number, azimuth: number): void, captureSkyLight(): void }}
 *   sunDirection is updated in place by setSunAngles, so anything holding it
 *   (the fog's inscattering) follows the sun without being told.
 */
export function addOutdoorLight({ scene, renderer, centre, reach }) {
  const sunAngles = { elevation: SUN_ELEVATION, azimuth: SUN_AZIMUTH };
  const sunDirection = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - SUN_ELEVATION),
    THREE.MathUtils.degToRad(SUN_AZIMUTH),
  );

  // --- sky atmosphere ----------------------------------------------------
  const sky = new Sky();
  sky.name = 'sky';
  // Drawn at the far plane whatever its size (the shader pins its depth
  // there); the scale only has to keep the camera inside the box.
  sky.scale.setScalar(10000);
  const uniforms = sky.material.uniforms;
  uniforms.turbidity.value = ATMOSPHERE.turbidity;
  uniforms.rayleigh.value = ATMOSPHERE.rayleigh;
  uniforms.mieCoefficient.value = ATMOSPHERE.mieCoefficient;
  uniforms.mieDirectionalG.value = ATMOSPHERE.mieDirectionalG;
  // The Sky has flat painted clouds of its own; those are left for the
  // cloud step.
  uniforms.cloudCoverage.value = 0;
  uniforms.sunPosition.value.copy(sunDirection);

  // --- sky light: the sky, captured ------------------------------------------
  // Rendered in a scene of its own, and without the sun disc: the disc is the
  // directional light's job, and captured it would be one blinding texel that
  // speckles every shiny surface. A function, because the sky can change
  // (the debug panel) and the capture is then out of date.
  let skyLight = null;
  // The sky as a plain cubemap as well -- small, linear HDR, sun disc left
  // out -- for the height fog to take its colour from (scene/outdoorPost.js).
  // One target, re-rendered in place, so the fog keeps the same texture.
  const skyTarget = new THREE.WebGLCubeRenderTarget(64, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  const skyCamera = new THREE.CubeCamera(0.1, 1000, skyTarget);
  function captureSkyLight() {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const captureScene = new THREE.Scene();
    const wasVisible = sky.visible;
    sky.visible = true;
    captureScene.add(sky);
    uniforms.showSunDisc.value = 0;
    const next = pmrem.fromScene(captureScene).texture;
    skyCamera.update(renderer, captureScene);
    uniforms.showSunDisc.value = 1;
    pmrem.dispose();
    scene.add(sky); // back out of captureScene: an object has one parent
    sky.visible = wasVisible;

    scene.environment = next;
    skyLight?.dispose();
    skyLight = next;
  }
  captureSkyLight();
  scene.environmentIntensity = SKY_LIGHT_INTENSITY;
  scene.background = null; // the Sky is the background now

  // --- directional light: the sun --------------------------------------------
  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.name = 'sun';
  sun.position.copy(centre).addScaledVector(sunDirection, reach * 2);
  sun.target.position.copy(centre);
  scene.add(sun.target);

  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  // Wide enough for the ground seen corner to corner from a slant.
  const extent = reach * Math.SQRT2;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = reach * 4;
  // A texel of this map is about 14 cm across the ground, so the offset that
  // stops a slope shadowing itself has to be of that order.
  sun.shadow.normalBias = 0.15;
  // Rendered once, not every frame: outside, nothing that casts a shadow
  // moves -- the terrain is still and the grass does not cast. It is redrawn
  // when the sun moves (setSunAngles) or something asks (requestShadowUpdate).
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  scene.add(sun);

  /** Move the sun: the sky's disc, the light, and sunDirection all follow. */
  function setSunAngles(elevation, azimuth) {
    sunAngles.elevation = elevation;
    sunAngles.azimuth = azimuth;
    sunDirection.setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(90 - elevation),
      THREE.MathUtils.degToRad(azimuth),
    );
    uniforms.sunPosition.value.copy(sunDirection);
    sun.position.copy(centre).addScaledVector(sunDirection, reach * 2);
    sun.shadow.needsUpdate = true;
  }

  // --- tone mapping ------------------------------------------------------------
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1; // outdoorPost.js's auto exposure does the rest

  return {
    sky, sun, sunDirection, sunAngles, setSunAngles, captureSkyLight,
    skyTexture: skyTarget.texture,
    /** The sky light's current capture -- what scene.environment is, outside. */
    get skyLight() { return skyLight; },

    /** Redraw the sun's shadow map on the next frame -- after something that casts moved. */
    requestShadowUpdate() {
      sun.shadow.needsUpdate = true;
    },

    /**
     * Out of the scene and off the GPU: the sky, the sun and its shadow map,
     * and both captures of the sky. The scene's environment and background
     * must already point elsewhere.
     */
    dispose() {
      scene.remove(sky, sun, sun.target);
      sky.geometry.dispose();
      sky.material.dispose();
      sun.shadow.dispose();
      skyLight?.dispose();
      skyLight = null;
      skyTarget.dispose();
    },
  };
}