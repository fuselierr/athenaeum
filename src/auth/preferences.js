import { nextTick, watch } from 'vue';
import { supabase } from './session.js';
import { account } from '../state/account.js';
import { settings, applySettings } from '../state/settings.js';
import { keys, applySavedBindings } from '../state/keybindings.js';

/**
 * Settings and key bindings that follow the reader's account.
 *
 * The browser keeps its own copy as it always has (state/settings.js,
 * state/keybindings.js) -- that is what a signed-out reader has, and what
 * is on screen before the account has been heard from. Signed in, the same
 * values are also kept in the account (the user_preferences table), so they
 * come back on another browser, another device, or after clearing the
 * browser's data.
 *
 * WHICH COPY WINS. Each side knows when it last changed: the account row
 * carries `updated_at`, and this browser remembers when its settings last
 * changed. On signing in the newer one wins -- a fresh device picks up the
 * account's, and changes made here while signed out go up to the account
 * rather than being overwritten by an older copy of it.
 *
 * WHAT STAYS WITH THE DEVICE. Graphics quality: the right preset is a fact
 * about the machine, and a gaming PC's "highest" would bring a laptop to a
 * crawl. Everything else -- audio, camera, walls, background, and the key
 * bindings -- goes with the reader.
 *
 * While signed in, changes are saved to the account a moment after they
 * stop, not on every tick of a slider. Other devices pick them up the next
 * time they load or sign in; nothing here is live.
 */

const TABLE = 'user_preferences';
const CHANGED_AT_KEY = 'athenaeum.preferences.changedAt';
const SAVE_DELAY_MS = 1000;

let userId = null;
let saveTimer = null;
let applying = false; // account values being put in place: not a change of the reader's
let unavailable = false; // the table is not there; browser-only for this visit

function localChangedAt() {
  try {
    return Number(localStorage.getItem(CHANGED_AT_KEY)) || 0;
  } catch {
    return 0;
  }
}

function markChanged(time) {
  try {
    localStorage.setItem(CHANGED_AT_KEY, String(time));
  } catch {
    // No storage: the account's copy wins every sign-in, which is fine.
  }
}

/** The settings that go to the account: all but what belongs to this device. */
function shareableSettings() {
  const copy = JSON.parse(JSON.stringify(settings));
  if (copy.graphics) delete copy.graphics.quality;
  return copy;
}

function failed(error) {
  const message = error?.message ?? String(error);
  // The table has not been created on this Supabase project.
  if (error?.code === 'PGRST205' || error?.code === '42P01' || /schema cache|does not exist/i.test(message)) {
    if (!unavailable) {
      console.warn('Settings are saved in this browser only: the user_preferences table does not exist yet.');
    }
    unavailable = true;
    account.preferences = 'unavailable';
    return;
  }
  console.warn('Could not sync settings with your account:', message);
  account.preferences = 'error';
}

/** Save this browser's settings and bindings to the account. */
async function push(id) {
  const { error } = await supabase.from(TABLE).upsert({
    user_id: id,
    settings: shareableSettings(),
    keybindings: { ...keys },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (userId !== id) return; // signed out, or in as someone else, meanwhile
  if (error) failed(error);
  else account.preferences = 'synced';
}

/** On signing in: take the account's copy, or send this browser's, whichever is newer. */
async function pull(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('settings, keybindings, updated_at')
    .eq('user_id', id)
    .maybeSingle();
  if (userId !== id) return;
  if (error) {
    failed(error);
    return;
  }

  const accountChangedAt = data ? Date.parse(data.updated_at) || 0 : 0;
  if (data && accountChangedAt > localChangedAt()) {
    applying = true;
    applySettings(data.settings);
    applySavedBindings(data.keybindings);
    // The stores' own watchers run in the next flush; they must see this as
    // the account's values arriving, not as the reader changing something.
    await nextTick();
    applying = false;
    markChanged(accountChangedAt);
    account.preferences = 'synced';
    return;
  }
  // This browser's are newer, or the account has none yet.
  await push(id);
}

/** Start keeping settings and bindings in step with whoever is signed in. Call once. */
export function startPreferencesSync() {
  // Every change the reader makes is stamped, signed in or not -- that is
  // what the next sign-in compares against the account.
  watch([settings, keys], () => {
    if (applying) return;
    markChanged(Date.now());
    if (!supabase || !userId || unavailable) return;
    clearTimeout(saveTimer);
    const id = userId;
    saveTimer = setTimeout(() => {
      push(id).catch(failed);
    }, SAVE_DELAY_MS);
  }, { deep: true });

  if (!supabase) return;

  watch(() => account.user?.id ?? null, (id) => {
    clearTimeout(saveTimer);
    userId = id;
    if (!id) {
      account.preferences = 'local';
      return;
    }
    if (unavailable) return;
    account.preferences = 'syncing';
    pull(id).catch(failed);
  }, { immediate: true });
}
