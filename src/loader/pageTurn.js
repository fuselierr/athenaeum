import * as THREE from 'three';

/**
 * Page-turn state for the two inner leaves. B/C show pageCanvases[leafStart]
 * and [leafStart + 1]; next()/prev() advance the window two pages at a time.
 * Covers (A, D) aren't wired in yet.
 *
 * @param {() => import('../book/pageSim/PageSimulation.js').PageSimulation} getPages
 *   returns the current simulation (it's recreated when page dimensions change)
 */
export function createPageTurn(getPages) {
  let pageCanvases = [];
  const pageTextures = []; // one CanvasTexture per page, built lazily, reused across turns
  let leafStart = 0;

  function textureForPage(index) {
    if (!pageCanvases[index]) return null;
    if (!pageTextures[index]) {
      pageTextures[index] = new THREE.CanvasTexture(pageCanvases[index]);
    }
    return pageTextures[index];
  }

  function showLeaf(start) {
    if (pageCanvases.length === 0) return;
    // Clamp so the window never runs past the end of the book.
    const maxStart = pageCanvases.length >= 2
      ? pageCanvases.length - (pageCanvases.length % 2 === 0 ? 2 : 1)
      : 0;
    leafStart = Math.max(0, Math.min(start, maxStart));

    // B/C are swapped vs the naive leafStart/leafStart+1 assignment to match
    // which page number was observed to land on which mesh.
    const b = textureForPage(leafStart + 1);
    const c = textureForPage(leafStart);
    const pages = getPages();
    if (b) pages.setPageTexture('B', b);
    if (c) pages.setPageTexture('C', c);
  }

  return {
    setCanvases(canvases) {
      pageCanvases = canvases;
      pageTextures.length = 0;
      showLeaf(0);
    },
    next() { showLeaf(leafStart + 2); },
    prev() { showLeaf(leafStart - 2); },
  };
}
