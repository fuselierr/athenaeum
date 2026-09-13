/**
 * The way into VR: a button along the bottom of the screen.
 *
 * Only put up on a browser that says it can show an immersive VR session
 * (navigator.xr) -- a headset's own browser, or a desktop one with a headset
 * attached. Anywhere else there is nothing to offer, so there is no button.
 *
 * @param {{ presenting: boolean, enter(): Promise<void>, exit(): void,
 *   onChange(listener: (presenting: boolean) => void): () => void }} vr
 *   input/vrControls.js
 * @returns {Promise<HTMLButtonElement|null>}
 */
export async function mountVRButton(vr) {
  let supported = false;
  try {
    supported = Boolean(await navigator.xr?.isSessionSupported('immersive-vr'));
  } catch {
    supported = false;
  }
  if (!supported) return null;

  if (!document.getElementById('vr-button-style')) {
    const style = document.createElement('style');
    style.id = 'vr-button-style';
    // The same glass and gradient ring as the corner controls (AccountButton.vue).
    style.textContent = `
      .vr-button {
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        z-index: 9;
        padding: 9px 22px;
        border: 1px solid transparent;
        border-radius: 999px;
        background:
          linear-gradient(var(--ath-glass-ring), var(--ath-glass-ring)) padding-box,
          var(--ath-accent-gradient) border-box;
        backdrop-filter: var(--ath-glass-blur);
        -webkit-backdrop-filter: var(--ath-glass-blur);
        box-shadow: 0 6px 20px rgba(20, 4, 18, 0.35);
        color: var(--ath-text);
        font: var(--ath-font);
        letter-spacing: 0.04em;
        cursor: pointer;
        transition: filter 0.12s ease;
      }
      .vr-button:hover:not(:disabled) { filter: brightness(1.15); }
      .vr-button:disabled { opacity: 0.6; cursor: default; }
      .vr-button:focus-visible { outline: none; box-shadow: var(--ath-focus); }
    `;
    document.head.appendChild(style);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'vr-button';
  const label = (presenting) => (presenting ? 'Exit VR' : 'Enter VR');
  button.textContent = label(vr.presenting);

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.title = '';
    try {
      if (vr.presenting) vr.exit();
      else await vr.enter();
    } catch (err) {
      console.error('Could not start VR:', err);
      button.title = `Couldn’t start VR: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  });
  vr.onChange((presenting) => { button.textContent = label(presenting); });

  document.body.appendChild(button);
  return button;
}
