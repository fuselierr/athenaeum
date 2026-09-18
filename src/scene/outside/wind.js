/**
 * The wind over the meadow.
 *
 * ONE GUST, shared. The grass (scene/outside/grass.js) and the tree
 * (scene/outside/tree.js) both lean in it, from these numbers and this
 * function -- so a gust that flattens the grass is the same gust that moves
 * the canopy above it, arriving at both at the same moment. Two wind systems
 * that merely look similar read as wrong even when each looks right alone:
 * the eye is very good at seeing that the grass and the tree are in different
 * weather.
 *
 * WHAT IT IS. A single wave rolling downwind across the whole field -- not
 * noise, not per-object. Anything standing at a spot asks how hard it is
 * blowing there, and leans by however much a thing of its own size and
 * stiffness would: a blade of grass nearly flat, a tree a few tenths of a
 * metre at its crown. The wave is long (about 25 m) and slow, so a gust takes
 * a few seconds to cross the clearing and you can watch it come.
 *
 * NOT THE CLOUDS. The volumetric clouds have a wind of their own, in metres
 * per second at altitude (scene/outside/volumetricClouds.js) -- weather a
 * thousand metres up, not the breeze at your feet, and no reason for the two
 * to agree.
 */

export const WIND = {
  /** Which way it blows, across the ground in world x/z. Normalized by its users. */
  direction: [1, 0.3],
  /** A master multiplier on how fast the weather travels. 1 is the speeds below. */
  speed: 1,

  // --- two octaves of it, and nothing else ----------------------------------
  // The wind IS the noise field, blown across the meadow. There is no wave
  // underneath it: a travelling sine arrives as straight parallel bands
  // sweeping at a constant rate, and once you have seen the rhythm you cannot
  // stop seeing it. Noise has no rhythm to find -- gusts come in patches,
  // curve round each other, and leave lulls behind them.
  //
  // Two scales, because one is either a slow swell with no texture or a busy
  // shimmer with no weather:
  //   the GUST, broad and slow, is the front crossing the field;
  //   the RIPPLE, smaller and quicker, is what runs through the grass inside it.
  //
  // SPEEDS ARE IN METRES PER SECOND, and the shader divides by the scale
  // rather than the other way about. Written as a rate in texture space -- as
  // this was at first -- the same number means a different wind at every
  // scale, and widening the gusts silently speeds them up. It is also how
  // these ended up more than a hundred times too fast: 0.245 of a tile per
  // second sounds slow and is 22 m/s. FluffyGrass scrolls its field at about
  // a tenth of a metre a second; a walking gust is a few.
  /** Metres across one tile of the broad field. Big, or the wind looks like rain. */
  gustScale: 140,
  /** How fast the gust front travels downwind, in metres per second. */
  gustSpeed: 1.8,
  /** And the finer one, over the top of it. */
  rippleScale: 42,
  rippleSpeed: 3.2,
  /** How much of the movement is the ripple rather than the gust, 0..1. */
  rippleShare: 0.3,
};

/** Where the noise field lives; loaded once a trip and shared (outside.js). */
export const WIND_NOISE_URL = '/grass/perlinnoise.webp';

/**
 * The gust, as GLSL. Include once in a shader that wants to lean in the wind,
 * then call it with a spot on the ground and the noise field.
 *
 * Deliberately a FUNCTION taking its direction, speed and texture rather than
 * reading uniforms of fixed names: the grass's are on sliders in the debug
 * panel and the tree's are not, so they cannot share a uniform -- only the
 * shape of the wave, which is the part that has to agree.
 *
 * SAMPLED AT AN EXPLICIT LOD. This is called from vertex shaders, where there
 * are no derivatives to choose a mip from; textureLod says which, rather than
 * leaving it to a rule that does not apply there.
 */
export const WIND_GLSL = /* glsl */`
  uniform sampler2D windNoise;
  uniform float windGustScale;
  uniform float windGustSpeed;
  uniform float windRippleScale;
  uniform float windRippleSpeed;
  uniform float windRippleShare;

  // How hard the wind is blowing at a spot on the ground, 0 to 1 -- read
  // straight out of the noise field, blown downwind. Nothing periodic.
  float windGust(vec2 worldXZ, float time, vec2 direction, float speed) {
    // The spot is walked UPWIND in metres before the field is read, which is
    // the same thing as the field travelling downwind over it. In metres,
    // then divided by the scale: so the scale says how big the gusts are and
    // the speed says how fast they move, and changing one leaves the other
    // alone.
    vec2 travel = direction * time * speed;
    vec2 gustAt = (worldXZ - travel * windGustSpeed) / windGustScale;
    vec2 rippleAt = (worldXZ - travel * windRippleSpeed) / windRippleScale;

    // The same channel at both scales: the two are far enough apart in size
    // and speed to be independent, and the texture's other channels are
    // wanted elsewhere.
    float gust = textureLod(windNoise, gustAt, 0.0).g;
    float ripple = textureLod(windNoise, rippleAt, 0.0).g;
    return clamp(mix(gust, ripple, windRippleShare), 0.0, 1.0);
  }
`;

/**
 * The field itself, as uniforms for everything that leans in it.
 *
 * ONE SET, SHARED. The grass and the tree are handed the same objects, so a
 * slider that widens the gusts widens them for both -- which is the whole
 * point of there being one wind (see the top of this file). Made per trip
 * outside, like everything else out there, so a new trip starts from these
 * defaults rather than from wherever the last one's sliders were left.
 *
 * @param {THREE.Texture} noise  the field, loaded once (grassClumps.js)
 */
export function createWindField(noise) {
  return {
    windNoise: { value: noise },
    windGustScale: { value: WIND.gustScale },
    windGustSpeed: { value: WIND.gustSpeed },
    windRippleScale: { value: WIND.rippleScale },
    windRippleSpeed: { value: WIND.rippleSpeed },
    windRippleShare: { value: WIND.rippleShare },
  };
}
