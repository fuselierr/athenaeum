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
  /** How fast the gust cycles. With the wavelength below, about 3 m/s downwind. */
  speed: 0.7,
  /**
   * Radians of the wave per metre downwind: a gust about 25 m from one crest
   * to the next, so a thing the size of the tree (13 m across) has a
   * noticeably different wind at its two sides and does not move as a block.
   */
  wavelength: 0.25,
};

/**
 * The gust, as GLSL. Include once in a shader that wants to lean in the wind,
 * then call it with a spot on the ground.
 *
 * Deliberately a FUNCTION taking its direction and speed rather than reading
 * uniforms of fixed names: the grass's are on sliders in the debug panel and
 * the tree's are not, so they cannot share a uniform -- only the shape of the
 * wave, which is the part that has to agree.
 */
export const WIND_GLSL = /* glsl */`
  // How hard the wind is blowing at a spot on the ground, 0 to 1.
  float windGust(vec2 worldXZ, float time, vec2 direction, float speed) {
    return sin(dot(worldXZ, direction) * ${WIND.wavelength.toFixed(4)} - time * speed) * 0.5 + 0.5;
  }
`;
