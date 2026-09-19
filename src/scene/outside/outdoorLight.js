import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { qualityPreset } from '../../state/quality.js';

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
 * (scene/outside/outdoorPost.js), so the renderer's own exposure stays at 1.
 */

// Where the sun is, in degrees: elevation above the horizon, and azimuth
// clockwise from +Z seen from above.
const SUN_ELEVATION = 55;
const SUN_AZIMUTH = 255;
const SUN_COLOR = 0xfff8f0;
const SUN_INTENSITY = 12;
// Low in the sky the sun's light has come through far more air, which takes
// the blue out of it and much of its strength: the colour it warms toward,
// and the elevations (degrees) over which it does -- fully warm at the first,
// its own colour from the second up.
const SUN_LOW_COLOR = 0xff9a50;
const SUN_WARM_BELOW = [2, 20];
// And it fades out as it reaches the horizon, rather than lighting the land
// at full strength from below the hills.
const SUN_FADE_BELOW = [-1, 6];

// The atmosphere. Turbidity is haze (2 very clear, 10 hazy); rayleigh is
// the blue of clean air; the Mie terms are the glow around the sun.
const ATMOSPHERE = {
  turbidity: 2,
  rayleigh: 1.4,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
};

// UNDER AN OVERCAST the sky is one grey lid: no blue left in it, bright all
// over rather than round the sun, and the sun itself only a paler patch of it.
// setOvercast(0..1) blends the atmosphere above toward this -- haze
// everywhere, the blue scattered out -- and takes the sun down with it. Every
// consumer of the sky's light follows from the recapture that comes after:
// the sky light, the fog's colour, the clouds' own ambient, the mountains'
// haze. How overcast it is comes from the clouds (outside.js).
const OVERCAST_ATMOSPHERE = {
  turbidity: 18,
  rayleigh: 0.2,
  mieCoefficient: 0.03,
  mieDirectionalG: 0.35,
};
// The share of the sun's direct light an overcast takes away: not all of it,
// or a total overcast would lose all sense of where the sun is.
const OVERCAST_SUN_CUT = 0.9;

// How strongly the captured sky lights the scene.
const SKY_LIGHT_INTENSITY = 0.5;

// How overcast the sky is, from how much of it the clouds cover: none of it
// below OVERCAST_FROM -- a sunny day with clouds in it -- and a full grey lid
// by OVERCAST_FULL.
const OVERCAST_FROM = 0.6;
const OVERCAST_FULL = 0.95;

/**
 * How overcast (0..1) a cloud coverage (0..1) makes the sky. Outside reads
 * the coverage off its clouds (outside.js); the room, whose windows look out
 * on the same sky, reads it off their settings (scene/inside/roomDaylight.js).
 */
export function overcastFor(coverage) {
  return THREE.MathUtils.smoothstep(coverage, OVERCAST_FROM, OVERCAST_FULL);
}

/**
 * The sun's light at an elevation (degrees) under an overcast (0..1): the
 * colour it has come through the air as, written into `colour`, and the share
 * of its full strength left -- warmer and dimmer toward the horizon, gone
 * below it, and cut by cloud. The one rule for every light that stands in for
 * the sun, outside and through the room's windows.
 *
 * @param {number} elevation
 * @param {number} overcast
 * @param {THREE.Color} colour
 * @returns {number}
 */
export function sunShade(elevation, overcast, colour) {
  const warm = 1 - THREE.MathUtils.smoothstep(elevation, SUN_WARM_BELOW[0], SUN_WARM_BELOW[1]);
  colour.set(SUN_COLOR).lerp(_lowColour, warm);
  return THREE.MathUtils.smoothstep(elevation, SUN_FADE_BELOW[0], SUN_FADE_BELOW[1])
    * (1 - OVERCAST_SUN_CUT * overcast);
}
const _lowColour = new THREE.Color(SUN_LOW_COLOR);

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
  // The clear sky's atmosphere, as set -- by default or from the debug panel
  // -- before any overcast is blended over it (applyAtmosphere).
  const atmosphere = { ...ATMOSPHERE };
  let overcast = 0;
  function applyAtmosphere() {
    for (const name of Object.keys(ATMOSPHERE)) {
      uniforms[name].value = THREE.MathUtils.lerp(atmosphere[name], OVERCAST_ATMOSPHERE[name], overcast);
    }
  }
  applyAtmosphere();
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
  // out -- for the height fog to take its colour from (scene/outside/outdoorPost.js).
  // One target, re-rendered in place, so the fog keeps the same texture.
  //
  // The fog reads it heavily blurred, a mip only a handful of texels across,
  // so anything small and bright in it turns into a bright square: the sun's
  // halo did, and the fog painted a block of haze round the sun. So it is
  // captured WITHOUT the halo -- the sky's haze kept, its forward glow taken
  // out -- and the fog adds its own smooth, round glow toward the sun instead.
  // 128 a face rather than 64, so that blurred mip is less blocky too.
  const skyTarget = new THREE.WebGLCubeRenderTarget(128, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  const skyCamera = new THREE.CubeCamera(0.1, 1000, skyTarget);
  // One generator for every capture, kept: the time of day and the overcast
  // recapture the sky several times a second while they move, and a new one
  // each time would build its blur material and targets again from nothing.
  const pmrem = new THREE.PMREMGenerator(renderer);
  function captureSkyLight() {
    const captureScene = new THREE.Scene();
    const wasVisible = sky.visible;
    sky.visible = true;
    captureScene.add(sky);
    uniforms.showSunDisc.value = 0;
    const next = pmrem.fromScene(captureScene).texture;
    // The fog's copy, with the halo round the sun taken out (see skyTarget):
    // Mie scattering made even in every direction keeps the haze but loses
    // the glow. The sky light above keeps it -- that capture is filtered
    // properly, not read a few texels across.
    const glow = uniforms.mieDirectionalG.value;
    uniforms.mieDirectionalG.value = 0;
    skyCamera.update(renderer, captureScene);
    uniforms.mieDirectionalG.value = glow;
    uniforms.showSunDisc.value = 1;
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
  // Sized by the graphics quality; ui/bindSettings.js resizes it if that changes.
  const shadowSize = qualityPreset().sunShadow;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
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

  // The sun's brightness as set -- by default, or by the debug panel -- before
  // the horizon takes its share (setSunAngles).
  let sunIntensity = SUN_INTENSITY;
  function shadeSun() {
    sun.intensity = sunIntensity * sunShade(sunAngles.elevation, overcast, sun.color);
  }

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
    shadeSun();
  }
  shadeSun();

  // --- tone mapping ------------------------------------------------------------
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1; // outdoorPost.js's auto exposure does the rest

  return {
    sky, sun, sunDirection, sunAngles, setSunAngles, captureSkyLight,
    /**
     * The sun's full brightness. Set this rather than sun.intensity, which
     * is this taken down near the horizon and set again whenever the sun moves.
     */
    /**
     * The clear sky's atmosphere: turbidity, rayleigh, mieCoefficient,
     * mieDirectionalG. Change one, then applyAtmosphere() and recapture --
     * the sky drawn is this with the overcast blended over it.
     */
    atmosphere,
    applyAtmosphere,

    /** How overcast it is, 0 clear .. 1 a grey lid. */
    get overcast() { return overcast; },
    /**
     * Grey the sky and dim the sun by `amount` (0..1). The sky light is a
     * capture, so it is left for the caller to take again.
     */
    setOvercast(amount) {
      overcast = THREE.MathUtils.clamp(amount, 0, 1);
      applyAtmosphere();
      shadeSun();
    },

    get sunIntensity() { return sunIntensity; },
    set sunIntensity(value) {
      sunIntensity = value;
      shadeSun();
    },
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
      pmrem.dispose();
    },
  };
}