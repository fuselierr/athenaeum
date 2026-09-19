<script setup>
import { computed, ref } from 'vue';
import { landing } from '../state/landing.js';
import { book } from '../state/book.js';
import { community } from '../state/community.js';
import { account } from '../state/account.js';
import { signInWith } from '../auth/session.js';

/**
 * The welcome page: what someone who is not signed in sees when they arrive.
 *
 * Bring a book and start reading. Choosing an EPUB here converts it and
 * takes you straight outside with it in your hand -- no account, nothing
 * kept. main.js decides when this is up (it is the first thing a signed-out
 * visitor sees, before the loading screen lifts) and does the opening; this
 * only asks for the file, through the bridge, the way the menu does.
 *
 * OR AN EXAMPLE. Most people arriving have no EPUB to hand and are not going
 * to go and find one to see whether this is worth their time, so a few of the
 * shelf's own books are offered beside the upload -- the same books, opened
 * the same way the shelf opens them. They come from the listing the room has
 * already fetched, so the offer costs nothing and simply is not there when
 * the library could not be reached. WHICH three is a fresh draw every visit,
 * from all the shelf's books, so the page is not the same three covers
 * forever -- drawn once, though, and kept for the visit: a row that
 * reshuffled whenever the listing updated would move under the pointer.
 *
 * NOTHING ELSE IS ON SCREEN while this is up: the corner's controls, the
 * menu, the VR button and the debug overlays all stand aside
 * (ui/AccountButton.vue, ui/menu/MenuRoot.vue, main.js). So signing in -- how
 * a returning reader gets their own shelf back -- is here, as its own button:
 * the same providers the corner offers, through the same call.
 */

const props = defineProps({ bridge: { type: Object, required: true } });
const input = ref(null);

// While a book is opening, the loader's own progress is the status line.
const busy = computed(() => book.loading);

// Each book's place in this visit's draw, given the first time it is seen and
// kept -- so the three stay put as the listing fills in or refreshes.
const draw = new Map();
const drawn = (id) => {
  if (!draw.has(id)) draw.set(id, Math.random());
  return draw.get(id);
};

// A few off the shelf, with whatever cover each is wearing. Three: enough to
// look like a choice, few enough to stay one line and not become a library.
const examples = computed(() => [...community.books]
  .sort((a, b) => drawn(a.id) - drawn(b.id))
  .slice(0, 3)
  .map((entry) => ({
    ...entry,
    cover: community.attachments[entry.id]?.front ?? entry.coverUrl ?? null,
  })));

// Signing in: the providers, shown when asked for.
const signingIn = ref(false);
const canSignIn = computed(() => account.ready && account.available);

/** Is a redirect to this provider the one in flight? */
function opening(provider) {
  return account.busy && account.provider === provider;
}

function choose() {
  if (busy.value) return;
  input.value?.click();
}

function picked(event) {
  const file = event.target.files?.[0];
  // Cleared straight away, so picking the same file again still fires a
  // change -- after a failure, that is exactly what someone will try.
  event.target.value = '';
  if (file) props.bridge.startWithBook(file);
}

function openExample(entry) {
  if (busy.value) return;
  props.bridge.startWithExample?.(entry);
}
</script>

<template>
  <div v-if="landing.showing" class="landing">
    <div class="card">
      <img class="icon" src="/appicon.png" alt="">
      <h1>Welcome to Athenaeum</h1>
      <p class="blurb">
        A reading room you can walk around in. Bring an EPUB and it opens in your
        hands, out on the hillside.
      </p>

      <button class="start" type="button" :disabled="busy" @click="choose">
        {{ busy ? 'Opening…' : 'Upload EPUB' }}
      </button>
      <input
        ref="input"
        type="file"
        accept=".epub,application/epub+zip"
        hidden
        @change="picked"
      >

      <template v-if="examples.length">
        <p class="or">or start with one of ours</p>
        <ul class="examples">
          <li v-for="entry in examples" :key="entry.id">
            <button type="button" :disabled="busy" :title="entry.author || entry.title"
                    @click="openExample(entry)">
              <img v-if="entry.cover" :src="entry.cover" alt="" class="cover">
              <span v-else class="cover blank" aria-hidden="true"></span>
              <span class="name">{{ entry.title }}</span>
            </button>
          </li>
        </ul>
      </template>

      <p v-if="busy && book.status" class="status" role="status" aria-live="polite">
        {{ book.status }}
      </p>
      <p v-else-if="landing.error" class="error" role="alert">{{ landing.error }}</p>

      <div class="account">
        <p class="hint">Have an account? Your own shelf is waiting.</p>
        <button
          v-if="!signingIn"
          class="login"
          type="button"
          :disabled="!canSignIn || busy"
          :title="account.ready && !account.available ? account.error : ''"
          @click="signingIn = true"
        >Log in / Sign up</button>

        <div v-else class="providers" role="group" aria-label="Log in or sign up">
          <button class="provider google" type="button" :disabled="account.busy"
                  @click="signInWith('google')">
            {{ opening('google') ? 'Opening Google…' : 'Continue with Google' }}
          </button>
          <button class="provider discord" type="button" :disabled="account.busy"
                  @click="signInWith('discord')">
            {{ opening('discord') ? 'Opening Discord…' : 'Continue with Discord' }}
          </button>
          <p class="note">First time here? Either one creates your account.</p>
          <button class="back" type="button" :disabled="account.busy" @click="signingIn = false">
            Back
          </button>
        </div>
        <p v-if="account.error && signingIn" class="error" role="alert">{{ account.error }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Over the room and the small labels (2). The menu and the corner stand
   aside entirely while this is up, so nothing needs to be above it. */
.landing {
  position: fixed;
  inset: 0;
  z-index: 9;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(120% 90% at 25% 15%, rgba(255, 155, 80, 0.10), transparent 60%),
    radial-gradient(110% 90% at 85% 95%, rgba(166, 107, 255, 0.14), transparent 60%),
    rgba(26, 9, 28, 0.72);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--ath-text);
  font: var(--ath-font);
}

.card {
  display: grid;
  justify-items: center;
  gap: 16px;
  width: min(420px, 100%);
  padding: 32px 28px;
  text-align: center;
  background: var(--ath-glass-strong);
  backdrop-filter: var(--ath-glass-blur);
  -webkit-backdrop-filter: var(--ath-glass-blur);
  border: 1px solid var(--ath-line);
  border-radius: var(--ath-radius);
  box-shadow: var(--ath-shadow);
}

.icon {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(20, 4, 18, 0.5);
}

h1 {
  margin: 0;
  font: 400 26px/1.3 var(--ath-serif);
  letter-spacing: 0.04em;
}

.blurb {
  margin: 0;
  max-width: 32ch;
  color: var(--ath-text-dim);
  font-size: 13px;
}

/* The one thing to do here, so it wears the full accent rather than the
   quiet control grey the menu's buttons use. */
.start {
  margin-top: 4px;
  padding: 11px 26px;
  color: #2a0f22;
  font: 500 14px/1 var(--ath-serif);
  letter-spacing: 0.02em;
  background: var(--ath-accent-gradient);
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  transition: transform 0.15s ease, filter 0.15s ease;
}

.start:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
.start:focus-visible { outline: none; box-shadow: var(--ath-focus); }
.start:disabled { cursor: default; filter: saturate(0.5) brightness(0.85); }

/* Quieter than the upload: the second way in, not a second headline. */
.or {
  margin: 2px 0 0;
  color: var(--ath-text-faint);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.examples {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.examples button {
  display: grid;
  justify-items: center;
  gap: 6px;
  width: 78px;
  padding: 6px;
  color: var(--ath-text-soft);
  font: var(--ath-font);
  background: var(--ath-control);
  border: 1px solid var(--ath-line);
  border-radius: var(--ath-radius-sm);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.examples button:hover:not(:disabled) {
  background: var(--ath-control-hover);
  border-color: var(--ath-line-strong);
}
.examples button:focus-visible { outline: none; box-shadow: var(--ath-focus); }
.examples button:disabled { cursor: default; opacity: 0.5; }

.cover {
  width: 100%;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  border-radius: 3px;
  background: var(--ath-field);
}

.blank { display: block; }

/* Two lines of title, then an ellipsis: the covers must stay a straight row,
   and a long title would otherwise make its tile twice the height. */
.name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.3;
}

.status, .hint, .error {
  margin: 0;
  min-height: 1.5em;
  font-size: 12px;
}

/* Signing in: under a hairline, after the ways to start reading -- the
   other way in, for someone who has been here before. */
.account {
  display: grid;
  justify-items: center;
  gap: 10px;
  width: 100%;
  padding-top: 14px;
  border-top: 1px solid var(--ath-line);
}

.login, .back {
  padding: 8px 20px;
  color: var(--ath-text);
  font: 500 13px/1 var(--ath-serif);
  background: var(--ath-control);
  border: 1px solid var(--ath-line-strong);
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.login:hover:not(:disabled), .back:hover:not(:disabled) {
  background: var(--ath-control-hover);
  border-color: var(--ath-orange);
}
.login:focus-visible, .back:focus-visible, .provider:focus-visible { outline: none; box-shadow: var(--ath-focus); }
.login:disabled, .back:disabled { cursor: default; opacity: 0.5; }
.back { padding: 6px 16px; font-size: 12px; }

.providers {
  display: grid;
  justify-items: center;
  gap: 8px;
  width: min(260px, 100%);
}

.provider {
  width: 100%;
  height: 38px;
  border-radius: 6px;
  font: 500 13px/1 var(--ath-serif);
  cursor: pointer;
}
.provider:disabled { opacity: 0.6; cursor: default; }

/* Each in its own brand's colours, as the corner's are (AccountButton.vue). */
.google { background: #fff; color: #1f1f1f; border: 1px solid #dadce0; }
.google:hover:not(:disabled) { background: #f3f5f8; }
.discord { background: #5865f2; color: #fff; border: 1px solid #5865f2; }
.discord:hover:not(:disabled) { background: #4752c4; border-color: #4752c4; }

.note {
  margin: 0;
  color: var(--ath-text-dim);
  font-size: 12px;
}

.status { color: var(--ath-text-soft); }
.hint { color: var(--ath-text-faint); }
.error { color: var(--ath-danger); }

@media (prefers-reduced-motion: reduce) {
  .start { transition: none; }
  .start:hover:not(:disabled) { transform: none; }
}
</style>
