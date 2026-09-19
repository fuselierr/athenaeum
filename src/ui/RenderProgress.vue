<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { book } from '../state/book.js';

/**
 * How far the book in your hands has got drawing its pages.
 *
 * A book arrives as soon as its shape is known, and its pages are drawn into
 * it afterwards (loader/bookLoader.js's openPdfPages) -- so for a while some
 * pages are blank paper, and this says how long that lasts. It fills while
 * the pages are rendering, says so once they all are, and then gets out of
 * the way.
 *
 * "ALL READY" ONLY WHEN IT WAS SEEN FILLING. Switching to a book whose pages
 * were finished long ago is not news, so the closing message is shown only
 * when this bar was up for that same book a moment before.
 */

// How long "all pages ready" stays before the bar fades, in milliseconds.
const DONE_FOR = 1600;

const rendering = computed(() => book.pagesTotal > 0 && book.pagesRendered < book.pagesTotal);
const share = computed(() => (book.pagesTotal > 0 ? book.pagesRendered / book.pagesTotal : 0));

const finished = ref(false);
let hideTimer = null;

watch(() => [book.pagesRendered, book.pagesTotal], ([done, total], [wasDone, wasTotal] = []) => {
  const justFinished = total > 0 && done === total && total === wasTotal && wasDone < wasTotal;
  if (justFinished) {
    finished.value = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { finished.value = false; }, DONE_FOR);
  } else if (done < total || total === 0) {
    // Another book, or this one starting over: whatever was being said is over.
    clearTimeout(hideTimer);
    finished.value = false;
  }
});
onBeforeUnmount(() => clearTimeout(hideTimer));

const showing = computed(() => rendering.value || finished.value);
</script>

<template>
  <transition name="render-fade">
    <div
      v-if="showing"
      class="render-progress"
      role="progressbar"
      aria-label="Rendering the book's pages"
      :aria-valuemin="0"
      :aria-valuemax="book.pagesTotal"
      :aria-valuenow="book.pagesRendered"
    >
      <div class="render-row">
        <span class="render-label">{{ finished ? 'All pages ready' : 'Rendering pages' }}</span>
        <span class="render-count">{{ book.pagesRendered }} / {{ book.pagesTotal }}</span>
      </div>
      <div class="render-track">
        <div class="render-fill" :class="{ done: finished }" :style="{ width: `${share * 100}%` }"></div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
/* Bottom middle, clear of the corner's controls and of the book itself,
   which sits in the middle of the view. Passes the pointer through: it is
   something to glance at, not to click. */
.render-progress {
  position: fixed;
  left: 50%;
  top: 24px;
  z-index: 11;
  width: min(320px, calc(100vw - 32px));
  padding: 10px 14px 12px;
  transform: translateX(-50%);
  pointer-events: none;
  color: var(--ath-text);
  font: var(--ath-font);
  background: var(--ath-glass-strong);
  backdrop-filter: var(--ath-glass-blur);
  -webkit-backdrop-filter: var(--ath-glass-blur);
  border: 1px solid var(--ath-line);
  border-radius: 12px;
  box-shadow: var(--ath-shadow);
}

.render-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 12px;
}

.render-label { color: var(--ath-text-soft); }

.render-count {
  color: var(--ath-text-dim);
  font-variant-numeric: tabular-nums;
}

.render-track {
  height: 4px;
  overflow: hidden;
  background: var(--ath-control);
  border-radius: 999px;
}

.render-fill {
  height: 100%;
  background: var(--ath-accent-gradient);
  border-radius: inherit;
  transition: width 0.25s ease;
}

.render-fill.done { filter: brightness(1.1); }

.render-fade-enter-active,
.render-fade-leave-active { transition: opacity 0.35s ease; }
.render-fade-enter-from,
.render-fade-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .render-fill,
  .render-fade-enter-active,
  .render-fade-leave-active { transition: none; }
}
</style>
