<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { account } from '../../state/account.js';
import { book } from '../../state/book.js';
import { community } from '../../state/community.js';
import {
  searchCovers, attachCover, detachCover, publishCover, MAX_IMAGE_BYTES,
} from '../../community/covers.js';

/**
 * Covers other readers have made, for your own books -- and yours to share.
 *
 * FIND. Search runs as you type, over title, author and keywords; with
 * nothing typed it lists everything, most used first. Each listing shows the
 * cover laid out flat the way a jacket is, back, spine and front, and how
 * many readers have it on a book.
 *
 * USE. Pick one of your shelf books and the cover goes on it -- saved to
 * your account (community/covers.js), and the shelf follows (main.js
 * watches the store). Browsing needs no account; putting a cover on a book
 * and sharing one both do.
 *
 * SHARE. Three images and a title, and it is in the listing for everyone.
 */

const signedIn = computed(() => Boolean(account.user));

// --- find ------------------------------------------------------------------
const query = ref('');
const results = ref([]);
const searching = ref(false);
const searched = ref(false);
const searchError = ref('');
let searchToken = 0;
let searchTimer = null;

async function runSearch() {
  const token = (searchToken += 1);
  searching.value = true;
  searchError.value = '';
  try {
    const found = await searchCovers(query.value);
    if (token === searchToken) results.value = found;
  } catch (err) {
    if (token === searchToken) searchError.value = err.message;
  } finally {
    if (token === searchToken) {
      searching.value = false;
      searched.value = true;
    }
  }
}

// Not on every keystroke: a word at a time, once typing pauses.
watch(query, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
});
onMounted(runSearch);

function usersLabel(count) {
  if (!count) return 'No one is using it yet';
  return count === 1 ? '1 reader is using it' : `${count} readers are using it`;
}

// --- use -------------------------------------------------------------------
const targets = reactive({}); // design id -> the book picked for it, once someone picks
const busy = ref(''); // the design or book being written, or ''
const actionError = ref('');

/** The book a listing offers first: one with the same title, or the one open, or the first. */
function defaultTarget(design) {
  const title = design.title?.trim().toLowerCase();
  const sameTitle = community.books.find((entry) => entry.title?.trim().toLowerCase() === title);
  const open = community.books.find((entry) => entry.id === book.id);
  return (sameTitle ?? open ?? community.books[0])?.id ?? '';
}

const targetFor = (design) => targets[design.id] ?? defaultTarget(design);
const wearers = (design) => community.books.filter((entry) => community.attachments[entry.id]?.id === design.id);

function canAttach(design) {
  const target = targetFor(design);
  return signedIn.value && !busy.value && Boolean(target) && community.attachments[target]?.id !== design.id;
}

function attachLabel(design) {
  if (busy.value === design.id) return 'Putting it on…';
  return community.attachments[targetFor(design)]?.id === design.id ? 'On this book' : 'Use on this book';
}

/**
 * Keep the listed counts honest after a change of your own, without a
 * fresh search: you count once for a cover however many of your books wear
 * it, so only your first book on it and your last one off it move the count.
 */
function recount(before) {
  const mine = (attachments, id) => Object.values(attachments).some((worn) => worn?.id === id);
  for (const design of results.value) {
    const was = mine(before, design.id);
    const is = mine(community.attachments, design.id);
    if (was !== is) design.users = Math.max(0, design.users + (is ? 1 : -1));
  }
}

async function attach(design) {
  const target = community.books.find((entry) => entry.id === targetFor(design));
  if (!target) return;
  const before = { ...community.attachments };
  busy.value = design.id;
  actionError.value = '';
  try {
    await attachCover(target, design);
    recount(before);
  } catch (err) {
    actionError.value = `Couldn't put that cover on ${target.title ?? 'the book'}: ${err.message}`;
  } finally {
    busy.value = '';
  }
}

async function restore(entry) {
  const before = { ...community.attachments };
  busy.value = entry.id;
  actionError.value = '';
  try {
    await detachCover(entry.id);
    recount(before);
  } catch (err) {
    actionError.value = `Couldn't give ${entry.title ?? 'the book'} its own cover back: ${err.message}`;
  } finally {
    busy.value = '';
  }
}

// --- share -----------------------------------------------------------------
const PARTS = [
  { key: 'back', label: 'Back' },
  { key: 'spine', label: 'Spine' },
  { key: 'front', label: 'Front' },
];
const draft = reactive({
  title: '', author: '', keywords: '', front: null, spine: null, back: null,
});
const previews = reactive({ front: '', spine: '', back: '' }); // object urls of the picked images
const publishing = ref(false);
const publishStatus = ref('');
const publishError = ref('');

function pick(part, event) {
  const file = event.target.files?.[0];
  // Cleared straight away, so picking the same file again still fires a change.
  event.target.value = '';
  if (!file) return;
  publishError.value = '';
  publishStatus.value = '';
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    publishError.value = 'Cover images must be PNG, JPEG or WebP.';
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    publishError.value = `Each image must be ${MAX_IMAGE_BYTES / (1024 * 1024)} MB or smaller.`;
    return;
  }
  if (previews[part]) URL.revokeObjectURL(previews[part]);
  draft[part] = file;
  previews[part] = URL.createObjectURL(file);
}

function useOpenBook() {
  draft.title = book.title ?? '';
  draft.author = book.author ?? '';
}

const canPublish = computed(() => (
  signedIn.value && !publishing.value && Boolean(draft.title.trim())
  && Boolean(draft.front && draft.spine && draft.back)
));

function clearDraft() {
  for (const { key } of PARTS) {
    if (previews[key]) URL.revokeObjectURL(previews[key]);
    previews[key] = '';
    draft[key] = null;
  }
  draft.title = '';
  draft.author = '';
  draft.keywords = '';
}

async function publish() {
  if (!canPublish.value) return;
  publishing.value = true;
  publishError.value = '';
  publishStatus.value = 'Uploading…';
  try {
    const design = await publishCover({
      title: draft.title,
      author: draft.author,
      keywords: draft.keywords,
      front: draft.front,
      spine: draft.spine,
      back: draft.back,
    });
    results.value = [design, ...results.value.filter((listed) => listed.id !== design.id)];
    clearDraft();
    publishStatus.value = `Shared “${design.title}”. It’s at the top of the list above.`;
  } catch (err) {
    publishStatus.value = '';
    publishError.value = err.message;
  } finally {
    publishing.value = false;
  }
}

onBeforeUnmount(() => {
  clearTimeout(searchTimer);
  for (const { key } of PARTS) if (previews[key]) URL.revokeObjectURL(previews[key]);
});
</script>

<template>
  <section class="menu-section">
    <h3>Find a cover</h3>
    <input
      v-model="query"
      class="community-field"
      type="search"
      placeholder="Title, author or keyword"
      aria-label="Search shared covers"
    >
    <p v-if="!signedIn" class="menu-hint community-note">
      Anyone can browse. Sign in (top right) to put a cover on your books or share your own.
    </p>
    <p v-else-if="!community.books.length" class="menu-hint community-note">
      Your shelf hasn’t loaded, so there’s no book to put a cover on yet.
    </p>
    <p v-if="community.error" class="community-error">{{ community.error }}</p>
    <p v-if="actionError" class="community-error">{{ actionError }}</p>
    <p v-if="searchError" class="community-error">{{ searchError }}</p>
    <p v-else-if="!results.length && (searching || !searched)" class="menu-hint community-note">Searching…</p>
    <p v-else-if="!results.length" class="menu-hint community-note">
      {{ query.trim() ? 'No shared covers match that.' : 'No one has shared a cover yet. Be the first, below.' }}
    </p>

    <ul class="covers">
      <li v-for="design in results" :key="design.id" class="cover">
        <div class="jacket" role="img" :aria-label="`${design.title}: back, spine and front`">
          <img class="jacket-board" :src="design.back" alt="" loading="lazy">
          <img class="jacket-spine" :src="design.spine" alt="" loading="lazy">
          <img class="jacket-board" :src="design.front" alt="" loading="lazy">
        </div>

        <div class="cover-info">
          <strong class="cover-title">{{ design.title }}</strong>
          <span v-if="design.author" class="cover-author">{{ design.author }}</span>
          <div v-if="design.keywords.length" class="keywords">
            <button
              v-for="word in design.keywords"
              :key="word"
              class="keyword"
              type="button"
              :title="`Search for “${word}”`"
              @click="query = word"
            >{{ word }}</button>
          </div>
          <span class="cover-users">{{ usersLabel(design.users) }}</span>
          <span v-if="wearers(design).length" class="cover-worn">
            On your {{ wearers(design).map((entry) => entry.title ?? entry.id).join(', ') }}
          </span>

          <div class="cover-use">
            <select
              class="community-field"
              :value="targetFor(design)"
              :disabled="!signedIn || !community.books.length"
              aria-label="Which of your books"
              @change="targets[design.id] = $event.target.value"
            >
              <option v-for="entry in community.books" :key="entry.id" :value="entry.id">
                {{ entry.title ?? entry.id }}
              </option>
            </select>
            <button class="menu-button" type="button" :disabled="!canAttach(design)" @click="attach(design)">
              {{ attachLabel(design) }}
            </button>
          </div>
        </div>
      </li>
    </ul>
  </section>

  <section v-if="signedIn && Object.keys(community.attachments).length" class="menu-section">
    <h3>Your books</h3>
    <div
      v-for="entry in community.books.filter((candidate) => community.attachments[candidate.id])"
      :key="entry.id"
      class="menu-row"
    >
      <span class="label">
        {{ entry.title ?? entry.id }}
        <span class="worn-note">wearing “{{ community.attachments[entry.id].title }}”</span>
      </span>
      <button class="menu-button" type="button" :disabled="Boolean(busy)" @click="restore(entry)">
        {{ busy === entry.id ? 'Restoring…' : 'Restore its own cover' }}
      </button>
    </div>
  </section>

  <section class="menu-section">
    <h3>Share a cover</h3>
    <p v-if="!signedIn" class="menu-hint">Sign in to share a cover you’ve made.</p>

    <form v-else class="share" @submit.prevent="publish">
      <div class="share-jacket">
        <label v-for="part in PARTS" :key="part.key" class="share-part" :class="part.key === 'spine' ? 'is-spine' : 'is-board'">
          <img v-if="previews[part.key]" :src="previews[part.key]" alt="">
          <span v-else class="share-empty">{{ part.label }}</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden @change="pick(part.key, $event)">
        </label>
      </div>
      <p class="menu-hint">
        Click each panel to pick its image. Front and back as they face you; the spine standing up,
        head at the top, as it looks on a shelf. PNG, JPEG or WebP, up to 5 MB each.
      </p>

      <div class="share-fields">
        <input v-model="draft.title" class="community-field" type="text" placeholder="Book title (required)" aria-label="Book title">
        <input v-model="draft.author" class="community-field" type="text" placeholder="Author" aria-label="Author">
        <input v-model="draft.keywords" class="community-field" type="text" placeholder="Keywords, separated by commas" aria-label="Keywords">
      </div>

      <div class="menu-row">
        <button v-if="book.title" class="menu-button" type="button" @click="useOpenBook">Use the open book’s title</button>
        <span class="label"></span>
        <button class="menu-button" type="submit" :disabled="!canPublish">
          {{ publishing ? 'Sharing…' : 'Share cover' }}
        </button>
      </div>
      <p v-if="publishError" class="community-error">{{ publishError }}</p>
      <p v-else-if="publishStatus" class="menu-hint">{{ publishStatus }}</p>
    </form>
  </section>
</template>

<style scoped>
.community-field {
  box-sizing: border-box;
  width: 100%;
  padding: 7px 10px;
  background: var(--ath-field);
  color: var(--ath-text);
  border: 1px solid var(--ath-line);
  border-radius: var(--ath-radius-sm);
  font: inherit;
}
.community-field:focus { border-color: var(--ath-orange); }
.community-field:disabled { opacity: 0.5; }

.community-note { margin-top: 8px; }
.community-error { margin: 8px 0 0; color: var(--ath-danger); font-size: 12px; }

.covers {
  display: grid;
  gap: 10px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}

.cover {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 14px;
  padding: 10px;
  background: var(--ath-control);
  border: 1px solid var(--ath-line);
  border-radius: var(--ath-radius-sm);
}

/* The cover laid out flat, as a jacket comes off a book: back, spine, front. */
.jacket {
  display: flex;
  align-self: start;
  height: 140px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--ath-field);
  box-shadow: 0 6px 16px rgba(10, 4, 10, 0.35);
}
.jacket img { height: 100%; object-fit: cover; display: block; }
.jacket-board { width: 94px; }
.jacket-spine {
  width: 20px;
  /* The folds either side of the spine. */
  box-shadow: inset 1px 0 0 rgba(0, 0, 0, 0.35), inset -1px 0 0 rgba(0, 0, 0, 0.35);
}

.cover-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cover-title {
  font-family: var(--ath-serif);
  font-size: 15px;
  font-weight: 400;
  color: var(--ath-text);
  overflow-wrap: anywhere;
}
.cover-author { color: var(--ath-text-soft); font-style: italic; }
.cover-users { color: var(--ath-orange-soft); font-size: 12px; }
.cover-worn { color: var(--ath-text-dim); font-size: 12px; }

.keywords { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0; }
.keyword {
  padding: 1px 8px;
  background: none;
  color: var(--ath-text-dim);
  border: 1px solid var(--ath-line);
  border-radius: 999px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.keyword:hover { color: var(--ath-text); border-color: var(--ath-orange); }

.cover-use { display: flex; gap: 8px; margin-top: auto; padding-top: 6px; }
.cover-use select { flex: 1; min-width: 0; }
.cover-use .menu-button { white-space: nowrap; }

.worn-note { display: block; color: var(--ath-text-dim); font-size: 12px; }

.share { display: grid; gap: 10px; }
.share-jacket { display: flex; justify-content: center; height: 150px; }
.share-part {
  display: grid;
  place-items: center;
  overflow: hidden;
  background: var(--ath-field);
  border: 1px dashed var(--ath-line-strong);
  cursor: pointer;
}
.share-part:hover { border-color: var(--ath-orange); }
.share-part.is-board { width: 100px; }
.share-part.is-spine { width: 24px; border-left: 0; border-right: 0; }
.share-part img { width: 100%; height: 100%; object-fit: cover; display: block; }
.share-empty { color: var(--ath-text-faint); font-size: 11px; }
.share-part.is-spine .share-empty { writing-mode: vertical-rl; }
.share-fields { display: grid; gap: 8px; }
</style>
