/**
 * Frames per second, for the debug overlay (the ` key): bottom right, inside
 * or out.
 *
 * Measured from the real time between calls -- not the render loop's own dt,
 * which is capped at 1/30 s and would hide exactly the slow frames worth
 * seeing. Averaged over half a second so the number can be read, with the
 * slowest frame in that window beside it: a steady 60 with one 200 ms hitch
 * is not the same as a steady 60.
 */

const WINDOW_MS = 500;

export function createFpsCounter() {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    zIndex: '10000',
    pointerEvents: 'none',
    font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: '#e8e8e8',
    background: 'rgba(12, 14, 20, 0.82)',
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(255, 255, 255, 0.14)',
    whiteSpace: 'pre',
    display: 'none',
    userSelect: 'none',
  });
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);

  let last = 0; // time of the previous call, ms
  let windowStart = 0;
  let frames = 0;
  let slowest = 0;

  return {
    /** Call once a frame, with whether the debug overlay is up. */
    update(visible) {
      const now = performance.now();
      el.style.display = visible ? 'block' : 'none';
      if (!visible) {
        // Start clean next time, rather than averaging over the time it was hidden.
        last = 0;
        return;
      }
      if (last === 0) {
        last = now;
        windowStart = now;
        frames = 0;
        slowest = 0;
        el.textContent = 'fps  --';
        return;
      }

      slowest = Math.max(slowest, now - last);
      last = now;
      frames += 1;

      const elapsed = now - windowStart;
      if (elapsed < WINDOW_MS) return;
      const fps = (frames * 1000) / elapsed;
      el.textContent = `fps  ${fps.toFixed(0).padStart(3)}\n` +
        `avg  ${(elapsed / frames).toFixed(1).padStart(5)} ms\n` +
        `max  ${slowest.toFixed(1).padStart(5)} ms`;
      windowStart = now;
      frames = 0;
      slowest = 0;
    },
  };
}