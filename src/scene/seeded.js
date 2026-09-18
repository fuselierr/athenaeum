/**
 * A seeded random: the same numbers, in the same order, from the same seed,
 * every visit. For anything laid out at random that should still be the same
 * each time you see it -- the grass's tile, the clouds' noise, the terrain's
 * variation.
 *
 * A linear congruential generator (Numerical Recipes' constants). Not a good
 * random for anything that matters; ample for scattering grass. Kept to this
 * exact arithmetic on purpose: the grass, the clouds and the terrain were all
 * laid out by it, and changing it would move every blade.
 *
 * @param {number} seed
 * @returns {() => number} 0 (inclusive) .. 1 (exclusive), a new one each call
 */
export function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
