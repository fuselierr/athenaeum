/**
 * A fixed HTML readout, top-right, of the hinge angles of A, D, P1 and P2.
 *
 *   A  / D   -- the real cover PAGES, the freely-swinging bodies
 *   P1 / P2  -- the two spreads' pseudo bodies: the invisible limit the
 *               board rides and that A/D clamp against
 *
 * Toggled with the ` key (same key as the 3D orientation labels -- both
 * are debug overlays and one key is enough). Off by default. Purely a
 * readout: never touches the simulation.
 *
 * Not drawn through three.js -- it's a plain absolutely-positioned <div>
 * layered over everything, with pointer-events off so it can't eat a drag
 * meant for the canvas underneath.
 */
export function createAnglePanel({ getPages }) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: '10000',
    pointerEvents: 'none',
    font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: '#e8e8e8',
    background: 'rgba(12, 14, 20, 0.82)',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(255, 255, 255, 0.14)',
    boxShadow: '0 2px 12px rgba(0, 0, 0, 0.5)',
    whiteSpace: 'pre',
    display: 'none',
    userSelect: 'none',
    minWidth: '150px',
  });
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);

  let visible = false;

  window.addEventListener('keydown', (e) => {
    // Ignore auto-repeat and anything with a modifier -- a bare ` press.
    if (e.key !== '`' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    visible = !visible;
    el.style.display = visible ? 'block' : 'none';
  });

  // Radians to a fixed-width "+1.234 rad ( +70.7 deg)" so columns line up
  // as the numbers change sign and magnitude.
  const RAD2DEG = 180 / Math.PI;
  function fmt(rad) {
    const r = rad.toFixed(3).padStart(6);
    const d = (rad * RAD2DEG).toFixed(1).padStart(6);
    return `${r} rad  (${d} deg)`;
  }

  function update() {
    if (!visible) return;

    const pages = getPages?.();
    if (!pages || typeof pages.panelAngles !== 'object') {
      el.textContent = 'angles\n  (no simulation)';
      return;
    }

    const { A, D, P1, P2 } = pages.panelAngles;
    el.textContent = [
      'hinge angles',
      `  A   ${fmt(A)}`,
      `  D   ${fmt(D)}`,
      `  P1  ${fmt(P1)}`,
      `  P2  ${fmt(P2)}`,
    ].join('\n');
  }

  function dispose() {
    el.remove();
  }

  return { update, dispose, get visible() { return visible; } };
}
