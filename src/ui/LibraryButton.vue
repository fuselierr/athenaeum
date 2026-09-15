<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { book } from '../state/book.js';
import { community } from '../state/community.js';

/**
 * Your books, from outside: a button under the account in the top right
 * corner, shown only while you are out of the room (AccountButton.vue).
 *
 * The shelf stays behind in the room, so this is the way to it from out
 * here: a list of its books, and picking one brings it into your hand
 * exactly as taking it off the shelf does indoors -- converted if it has to
 * be, then handed to you once its pages are ready (main.js's takeBook). The
 * book already out, lying on the desk, comes up into your hand the same way.
 */

const props = defineProps({ bridge: { type: Object, required: true } });

const open = ref(false);
const root = ref(null);

// The shelf's books, in its order, each with the cover it is wearing -- a
// shared one (the Community tab) or its own.
const books = computed(() => community.books.map((entry) => ({
  ...entry,
  cover: community.attachments[entry.id]?.front ?? entry.coverUrl ?? null,
})));

function take(entry) {
  props.bridge.takeBook?.(entry.id);
  open.value = false;
}

// A press anywhere else closes the list -- capture phase, as the account
// panel does, because the room's own gestures stop propagation.
function onPointerDown(event) {
  if (open.value && root.value && !root.value.contains(event.target)) open.value = false;
}
onMounted(() => window.addEventListener('pointerdown', onPointerDown, { capture: true }));
onBeforeUnmount(() => window.removeEventListener('pointerdown', onPointerDown, { capture: true }));
</script>

<template>
  <div ref="root" class="library">
    <button
      class="library-trigger"
      type="button"
      title="Your books"
      :aria-expanded="open"
      @click="open = !open"
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none"
           stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
        <path d="M3.5 3.5h3v13h-3zM8 3.5h3v13H8zM12.4 4.4l2.9-.8 3.2 12.4-2.9.8z" />
      </svg>
      <span>Books</span>
    </button>

    <p v-if="book.loading && book.status" class="library-status" role="status">{{ book.status }}</p>

    <div v-if="open" class="library-panel" role="dialog" aria-label="Your books">
      <p class="library-heading">Your books</p>
      <p v-if="!books.length" class="library-note">Your shelf hasn’t loaded, so there are no books to bring yet.</p>

      <ul v-else class="library-list">
        <li v-for="entry in books" :key="entry.id">
          <button
            class="library-book"
            :class="{ current: entry.id === book.id }"
            type="button"
            :disabled="book.loading && entry.id === book.id"
            @click="take(entry)"
          >
            <img v-if="entry.cover" class="library-cover" :src="entry.cover" alt="" loading="lazy">
            <span v-else class="library-cover library-cover-blank" aria-hidden="true"></span>
            <span class="library-text">
              <span class="library-title">{{ entry.title ?? entry.id }}</span>
              <span v-if="entry.author" class="library-author">{{ entry.author }}</span>
            </span>
            <span v-if="entry.id === book.id" class="library-tag">{{ book.loading ? 'Opening…' : 'Open' }}</span>
          </button>
        </li>
      </ul>

      <p v-if="books.length" class="library-note">Pick one and it comes into your hand.</p>
    </div>
  </div>
</template>

<style scoped>
.library {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

/* The same glass and gradient ring as the account button above it. */
.library-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 14px 0 12px;
  border: 1px solid transparent;
  border-radius: 17px;
  background:
    linear-gradient(var(--ath-glass-ring), var(--ath-glass-ring)) padding-box,
    var(--ath-accent-gradient) border-box;
  backdrop-filter: var(--ath-glass-blur);
  -webkit-backdrop-filter: var(--ath-glass-blur);
  box-shadow: 0 6px 20px rgba(20, 4, 18, 0.35);
  color: var(--ath-text);
  font: inherit;
  cursor: pointer;
  transition: filter 0.12s ease;
}
.library-trigger:hover { filter: brightness(1.15); }
.library-trigger:focus-visible { outline: none; box-shadow: var(--ath-focus); }

.library-status {
  max-width: 240px;
  margin: 0;
  padding: 4px 10px;
  border: 1px solid var(--ath-line);
  border-radius: 999px;
  background: var(--ath-glass-strong);
  color: var(--ath-text-soft);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.library-panel {
  position: absolute;
  top: 42px;
  right: 0;
  z-index: 1;
  box-sizing: border-box;
  width: 300px;
  max-height: min(60vh, 480px);
  overflow-y: auto;
  padding: 14px;
  background:
    linear-gradient(160deg, rgba(255, 155, 80, 0.10), rgba(166, 107, 255, 0.08) 70%, transparent),
    var(--ath-glass-strong);
  backdrop-filter: var(--ath-glass-blur);
  -webkit-backdrop-filter: var(--ath-glass-blur);
  border: 1px solid var(--ath-line);
  border-radius: 12px;
  box-shadow: var(--ath-shadow);
  scrollbar-color: rgba(255, 170, 110, 0.35) transparent;
}

.library-heading {
  margin: 0 0 10px;
  color: var(--ath-text);
  font-family: var(--ath-serif);
  font-size: 15px;
}

.library-note {
  margin: 10px 0 0;
  color: var(--ath-text-dim);
  font-size: 12px;
}

.library-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.library-book {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px;
  border: 0;
  border-radius: var(--ath-radius-sm);
  background: none;
  color: var(--ath-text-soft);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.library-book:hover:not(:disabled) { background: var(--ath-control-hover); color: var(--ath-text); }
.library-book:focus-visible { outline: none; box-shadow: var(--ath-focus); }
.library-book:disabled { cursor: default; }
/* The book that is out: an orange edge, like the current chapter's. */
.library-book.current {
  background: var(--ath-selected);
  color: var(--ath-text);
  box-shadow: inset 2px 0 0 var(--ath-orange);
}

.library-cover {
  flex: none;
  width: 32px;
  height: 46px;
  border-radius: 2px;
  object-fit: cover;
  box-shadow: 0 2px 6px rgba(10, 4, 10, 0.4);
}
.library-cover-blank { background: var(--ath-control); }

.library-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.library-title,
.library-author {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.library-title { font-family: var(--ath-serif); }
.library-author { color: var(--ath-text-dim); font-size: 12px; font-style: italic; }

.library-tag {
  flex: none;
  color: var(--ath-orange-soft);
  font-size: 11px;
}
</style>
