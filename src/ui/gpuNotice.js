/**
 * Which graphics chip the room is drawing on -- and, when it is not a good
 * one, how to change that.
 *
 * A web page cannot choose the GPU. The renderer asks for the faster one
 * (powerPreference: 'high-performance', scene/createScene.js), but that is
 * only a hint: on a laptop with both a built-in and a dedicated chip, the
 * browser -- or Windows, which decides per program -- often hands out the
 * built-in one anyway, and a browser with hardware acceleration switched off
 * draws everything on the CPU.
 *
 * So this reads the name of the chip WebGL actually got, and if it is a
 * built-in one (Intel, AMD's APU graphics) or software rendering, puts up a
 * small note with the steps for this operating system. Dismissed, it stays
 * dismissed for that chip; a different chip later brings it back.
 *
 * Apple Silicon, Snapdragon laptops and phones have only the one chip, so
 * there is nothing better to point them to, and no note.
 */

const DISMISSED_KEY = 'athenaeum.gpuNotice.dismissed';

/** The chip's name as WebGL reports it, unmasked where the browser allows. */
function rendererName(gl) {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/** "ANGLE (Intel, Intel(R) UHD Graphics 620 (0x5917) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "Intel(R) UHD Graphics 620" */
function readableName(name) {
  const angle = name.match(/^ANGLE \((.*)\)$/);
  const inner = angle ? (angle[1].split(',')[1] ?? angle[1]) : name;
  return inner
    .replace(/\s*\(0x[0-9a-f]+\).*$/i, '')
    .replace(/\s+(Direct3D|OpenGL|Metal|Vulkan|vs_).*$/i, '')
    .trim() || name;
}

/** 'software' | 'integrated' | null, from the chip's name. */
function classify(name) {
  if (/swiftshader|llvmpipe|softpipe|basic render|software/i.test(name)) return 'software';
  if (/intel/i.test(name) && !/\barc\b/i.test(name)) return 'integrated';
  if (/radeon(\(tm\))?\s*(vega\s*\d+\s*)?graphics/i.test(name)) return 'integrated';
  return null;
}

function platform() {
  const source = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  if (/win/i.test(source)) return 'windows';
  if (/mac/i.test(source)) return 'mac';
  if (/linux|x11/i.test(source)) return 'linux';
  return 'other';
}

const STEPS = {
  windows: [
    'Open Windows Settings → System → Display → Graphics.',
    'Find your browser in the list (or add it with “Browse”), open its Options and choose High performance.',
    'Close every browser window and open it again.',
  ],
  mac: [
    'Open System Settings → Battery → Options (or Energy Saver on older macOS).',
    'Turn off Automatic graphics switching, then reopen your browser.',
  ],
  linux: [
    'Start your browser on the dedicated GPU — for example with prime-run, or DRI_PRIME=1 — then reopen this page.',
  ],
  other: [
    'Set your browser to use the high-performance graphics card in your system’s graphics settings, then reopen it.',
  ],
};

const STYLE = `
  .gpu-notice {
    position: fixed;
    left: 12px;
    top: 12px;
    z-index: 9;
    width: min(360px, calc(100vw - 24px));
    box-sizing: border-box;
    padding: 12px 14px;
    border: 1px solid var(--ath-line);
    border-radius: var(--ath-radius);
    background: var(--ath-glass-strong);
    backdrop-filter: var(--ath-glass-blur);
    -webkit-backdrop-filter: var(--ath-glass-blur);
    box-shadow: var(--ath-shadow);
    color: var(--ath-text);
    font: var(--ath-font);
    font-size: 13px;
  }
  .gpu-notice strong {
    display: block;
    margin-bottom: 4px;
    font-family: var(--ath-serif);
    font-weight: 400;
    font-size: 14px;
  }
  .gpu-notice p { margin: 0 0 6px; color: var(--ath-text-soft); }
  .gpu-notice ol { margin: 0 0 8px; padding-left: 18px; color: var(--ath-text-dim); }
  .gpu-notice li { margin-bottom: 2px; }
  .gpu-notice button {
    padding: 5px 12px;
    background: var(--ath-control);
    color: var(--ath-text);
    border: 1px solid var(--ath-line-strong);
    border-radius: var(--ath-radius-sm);
    font: inherit;
    cursor: pointer;
  }
  .gpu-notice button:hover { background: var(--ath-control-hover); border-color: var(--ath-orange); }
  .gpu-notice button:focus-visible { outline: none; box-shadow: var(--ath-focus); }
`;

/**
 * Check the GPU the renderer got, and say something if it could be better.
 *
 * @param {import('three').WebGLRenderer} renderer
 * @returns {{ name: string, kind: 'software'|'integrated'|null }}
 */
export function checkGpu(renderer) {
  const raw = rendererName(renderer.getContext());
  const name = readableName(raw);
  const kind = classify(raw);
  console.info(`Drawing on: ${name || 'an unknown GPU'}${kind ? ` (${kind})` : ''}`);
  if (!kind) return { name, kind };

  try {
    if (localStorage.getItem(DISMISSED_KEY) === raw) return { name, kind };
  } catch {
    // No storage: the note just shows every visit.
  }

  if (!document.getElementById('gpu-notice-style')) {
    const style = document.createElement('style');
    style.id = 'gpu-notice-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  const notice = document.createElement('div');
  notice.className = 'gpu-notice';
  notice.setAttribute('role', 'status');

  const title = document.createElement('strong');
  const intro = document.createElement('p');
  const steps = document.createElement('ol');
  if (kind === 'software') {
    title.textContent = 'Graphics acceleration is off';
    intro.textContent = `Your browser is drawing the room without your graphics card (${name}), which will be slow. `
      + 'Turn on “Use graphics acceleration when available” in your browser’s settings, then restart it.';
  } else {
    title.textContent = `Running on ${name}`;
    intro.textContent = 'That is your computer’s built-in graphics. If it also has a dedicated graphics card '
      + '(NVIDIA or AMD), the room will run much better on it:';
    for (const step of STEPS[platform()]) {
      const item = document.createElement('li');
      item.textContent = step;
      steps.appendChild(item);
    }
  }

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Got it';
  dismiss.addEventListener('click', () => {
    try {
      localStorage.setItem(DISMISSED_KEY, raw);
    } catch {
      // Remembered for this visit only.
    }
    notice.remove();
  });

  notice.append(title, intro);
  if (steps.childElementCount) notice.append(steps);
  notice.append(dismiss);
  document.body.appendChild(notice);
  return { name, kind };
}
