import { reactive } from 'vue';

/**
 * Where the reader is: in the room, outside, or on the way out while the
 * outdoors loads. Written by scene/outside/outside.js, read by the Scene tab --
 * a fact about the world rather than a setting, so none of it is a preference
 * and none of it syncs to the account.
 *
 * It is not quite forgotten between visits, though: for a signed-in reader
 * this browser writes the place down as it changes, so closing the tab
 * outside and coming back opens outside (state/lastPlace.js).
 */
export const world = reactive({
  /** 'room' | 'loading' | 'outside' */
  place: 'room',
});