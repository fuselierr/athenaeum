<script setup>
import { computed, ref, watch } from 'vue';
import { book, chapterPage } from '../../state/book.js';
import UploadSection from './UploadSection.vue';

/**
 * Where you are in the book, and how to be somewhere else.
 *
 * The slider is deliberately not bound straight to `book.page`: dragging it
 * would then fight the value coming back from the reader as it turns. It
 * holds its own position while the thumb is down and re-syncs the moment it
 * is let go.
 */

const props = defineProps({ bridge: { type: Object, required: true } });

const scrubbing = ref(false);
const scrub = ref(1);
watch(() => book.page, (page) => { if (!scrubbing.value) scrub.value = page; }, { immediate: true });

const has = computed(() => book.pageCount > 0);
const percent = computed(() => (
  book.pageCount > 1 ? Math.round(((book.page - 1) / (book.pageCount - 1)) * 100) : 0
));

// Which chapter the current page falls in: the last one that starts at or
// before it. Chapters arrive sorted (server/epubToc.ts).
const currentChapter = computed(() => {
  let found = null;
  for (const chapter of book.chapters) {
    if (chapterPage(chapter) <= book.page) found = chapter;
    else break;
  }
  return found;
});

function goTo(page) {
  props.bridge.goToPage(page);
}

function commitScrub() {
  scrubbing.value = false;
  goTo(scrub.value);
}
</script>

<template>
  <div v-if="!has" class="menu-empty book-empty">
    <strong>No book open</strong>
    <span>Take one off the shelf, or open a file below.</span>
  </div>

  <template v-else>
    <section class="menu-section">
      <h3>Page</h3>

      <div class="menu-row">
        <button class="menu-button" type="button" :disabled="book.page <= 1"
                @click="props.bridge.turnPage(-1)">‹ Back</button>
        <button class="menu-button" type="button" :disabled="book.page >= book.pageCount - 1"
                @click="props.bridge.turnPage(1)">Forward ›</button>
        <span class="label"></span>
        <span class="value">{{ book.page }} / {{ book.pageCount }}</span>
      </div>

      <div class="menu-row">
        <input
          type="range" min="1" :max="book.pageCount" step="1"
          v-model.number="scrub"
          @pointerdown="scrubbing = true"
          @pointerup="commitScrub"
          @change="commitScrub"
        >
        <span class="value">{{ percent }}%</span>
      </div>

      <div class="menu-row">
        <span class="label">Jump to page</span>
        <input type="number" min="1" :max="book.pageCount" :value="book.page"
               @change="goTo(Number($event.target.value))">
        <button class="menu-button" type="button" @click="goTo(1)">Start</button>
        <button class="menu-button" type="button" @click="goTo(book.pageCount)">End</button>
      </div>
    </section>

    <section class="menu-section">
      <h3>Chapters</h3>

      <p v-if="!book.chapters.length" class="menu-hint">
        This book did not carry a usable table of contents, so there is
        nothing to list. Page navigation above still works.
      </p>

      <template v-else>
        <ul class="chapters">
          <li v-for="(chapter, i) in book.chapters" :key="i">
            <button
              type="button"
              class="chapter"
              :class="{ current: chapter === currentChapter }"
              @click="goTo(chapterPage(chapter))"
            >
              <span class="chapter-title">{{ chapter.title }}</span>
              <span class="chapter-page">{{ chapterPage(chapter) }}</span>
            </button>
          </li>
        </ul>
        <p class="menu-hint">
          Chapter pages are estimated from how much text comes before each
          one, so they land within a page or so rather than exactly.
        </p>
      </template>
    </section>
  </template>

  <!-- Both states: with nothing open it is how to open something, and with
       a book open it is how to open a different one. Its status line also
       replaces the one the empty state used to carry. -->
  <UploadSection :bridge="props.bridge" />
</template>

<style scoped>
/* The shared empty state fills the whole tab; here it has to leave room
   for the upload section beneath it. */
.book-empty { height: auto; padding: 36px 0 30px; }

.chapters { margin: 0 0 10px; padding: 0; list-style: none; }

.chapter {
  display: flex;
  width: 100%;
  gap: 12px;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #cfd6e4;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.chapter:hover { background: rgba(255, 255, 255, 0.05); }
.chapter.current { background: rgba(111, 140, 255, 0.14); color: #fff; }

.chapter-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chapter-page { color: #6f7a8e; font-variant-numeric: tabular-nums; }
</style>