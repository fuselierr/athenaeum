import { reactive } from 'vue';

/**
 * Where the reader is: in the room, outside, or on the way out while the
 * outdoors loads. Written by scene/outside.js, read by the Scene tab -- a
 * fact about the world rather than a setting, so nothing here is remembered
 * between visits.
 */
export const world = reactive({
  /** 'room' | 'loading' | 'outside' */
  place: 'room',
});