import { watch } from 'vue';
import { account } from './account.js';
import { world } from './world.js';

/**
 * Where the reader was when they closed the tab, so signing back in puts
 * them there again -- in the room, or out on the hillside.
 *
 * ONLY FOR SIGNED-IN READERS. A signed-out visitor gets the welcome page
 * (ui/LandingScreen.vue) and a book they chose there; there is nothing of
 * theirs to come back to.
 *
 * IN THE BROWSER, NOT THE ACCOUNT. "Where you were when you closed the tab"
 * is a fact about this browser, not about the reader: a phone that was never
 * outside should not open outside because a desktop was. So this sits in
 * localStorage beside the other things a browser keeps (state/settings.js),
 * and unlike settings it is deliberately NOT synced to the account
 * (auth/preferences.js).
 *
 * ONE READER AT A TIME. A single entry, stamped with whose it is, rather
 * than one per account: a browser that several people have signed into
 * would otherwise keep a row for each of them forever, and only the last
 * one is ever asked for. Someone else's entry simply does not match, and
 * they start in the room.
 *
 * WHAT IS NOT KEPT. Which book was open, where you were standing, what was
 * in your hand. Only the place -- and world.place holds exactly two of
 * those (the third, 'loading', is a moment in between and not somewhere to
 * come back to).
 */

const KEY = 'athenaeum.place';
const PLACES = ['room', 'outside'];

/**
 * Where this reader left off, or null if there is nothing kept for them --
 * they are new, this browser is, or the last person here was someone else.
 *
 * @param {string|null|undefined} userId
 * @returns {'room'|'outside'|null}
 */
export function placeFor(userId) {
  if (!userId) return null;
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (kept?.user !== userId || !PLACES.includes(kept?.place)) return null;
    return kept.place;
  } catch {
    // No storage, or something unreadable in it: they start in the room.
    return null;
  }
}

/**
 * Start writing the place down as it changes.
 *
 * CALLED AFTER the place has been restored, not before -- the world starts
 * every visit in the room, so a watcher running any earlier would write
 * 'room' over the 'outside' it is about to be asked for.
 */
export function startRememberingPlace() {
  watch(
    () => [account.user?.id ?? null, world.place],
    ([user, place]) => {
      if (!user || !PLACES.includes(place)) return;
      try {
        localStorage.setItem(KEY, JSON.stringify({ user, place }));
      } catch {
        // Nowhere to keep it; they start in the room next time.
      }
    },
  );
}
