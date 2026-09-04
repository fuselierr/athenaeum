/**
 * 2D image work for the book's jacket: sampling a binding colour out of the
 * cover art, and printing the spine label.
 *
 * Separate from hardcover.js, which is all 3D geometry. Nothing here knows
 * about three.js -- these return plain canvases and colours.
 *
 * Why any of this is synthesized: epub carries a front cover image and
 * nothing else. There is no back-cover or spine artwork in the format to
 * extract, so the rest of the jacket is derived from the one image plus
 * the book's own title/author metadata -- the same thing a physical book
 * puts on its spine.
 */

/**
 * The colour to bind the book in, sampled from the cover's OUTER BORDER
 * rather than its whole area. A cover's edges are nearly always its
 * background -- the base colour the design sits on -- whereas averaging
 * the full image drags in the artwork and title text and converges on
 * mud. Taking the border reads as "the colour of this book" and, on the
 * common case of a solid-background cover, matches it exactly.
 *
 * @param {CanvasImageSource & { width: number, height: number }} image
 * @returns {{ r: number, g: number, b: number }} 0-255 channels
 */
export function sampleBindingColor(image) {
  const fallback = { r: 74, g: 47, b: 36 }; // the default board brown
  const w = image.naturalWidth ?? image.width;
  const h = image.naturalHeight ?? image.height;
  if (!w || !h) return fallback;

  // Downsample hard first -- a border average does not need the full
  // resolution, and this keeps the readback to a few thousand pixels.
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, size, size);

  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return fallback; // tainted canvas (cross-origin cover) -- not worth throwing over
  }

  const band = Math.max(1, Math.round(size * 0.08));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const onBorder = x < band || y < band || x >= size - band || y >= size - band;
      if (!onBorder) continue;
      const i = (y * size + x) * 4;
      if (data[i + 3] < 128) continue; // ignore transparent margins
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  if (n === 0) return fallback;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/** Perceived lightness, 0-1, for picking readable text over a colour. */
export function luminance({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export const toHex = ({ r, g, b }) => (r << 16) | (g << 8) | b;

/** Scales a colour toward black (t < 1) or white (t > 1), clamped. */
export function shade({ r, g, b }, t) {
  const f = (c) => Math.max(0, Math.min(255, Math.round(t <= 1 ? c * t : c + (255 - c) * (t - 1))));
  return { r: f(r), g: f(g), b: f(b) };
}

/**
 * Draws the spine label: the title, and the author beneath it, running
 * along the spine's length the way a shelved book reads.
 *
 * `lengthPx` is the spine's long axis (the book's height) and `widthPx`
 * its short one (the book's thickness). The canvas is laid out in that
 * long/short orientation and the text is rotated into it, so callers can
 * hand the result straight to a texture without any further rotation.
 *
 * Type is auto-fitted: a thin book gives very little width to work with,
 * and a long title has to shrink to fit the length, so both axes are
 * measured rather than assumed.
 */
export function renderSpineLabel({ title, author, background, lengthPx = 1024, widthPx = 128 }) {
  const canvas = document.createElement('canvas');
  canvas.width = lengthPx;
  canvas.height = widthPx;
  const ctx = canvas.getContext('2d');

  const bg = background ?? { r: 74, g: 47, b: 36 };
  ctx.fillStyle = `rgb(${bg.r},${bg.g},${bg.b})`;
  ctx.fillRect(0, 0, lengthPx, widthPx);

  // Two hairlines just inside the edges, where a real spine has the turn
  // of the boards. Cheap, and it stops the spine reading as a flat decal.
  const edge = shade(bg, luminance(bg) > 0.5 ? 0.82 : 1.25);
  ctx.strokeStyle = `rgba(${edge.r},${edge.g},${edge.b},0.55)`;
  ctx.lineWidth = Math.max(1, widthPx * 0.03);
  for (const y of [widthPx * 0.1, widthPx * 0.9]) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(lengthPx, y); ctx.stroke();
  }

  if (!title && !author) return canvas;

  const ink = luminance(bg) > 0.5 ? 'rgba(20,16,14,0.92)' : 'rgba(245,238,225,0.94)';
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const usableLength = lengthPx * 0.86; // leave the head and tail clear
  const titleSize = fitFont(ctx, title ?? '', usableLength, widthPx * 0.42, '600');
  const authorSize = author ? fitFont(ctx, author, usableLength, widthPx * 0.26, '400') : 0;

  // Title above centre, author below, when both are present.
  const gap = widthPx * 0.06;
  const block = titleSize + (authorSize ? gap + authorSize : 0);
  let y = widthPx / 2 - block / 2 + titleSize / 2;

  if (title) {
    ctx.font = `600 ${titleSize}px Georgia, 'Times New Roman', serif`;
    ctx.fillText(title, lengthPx / 2, y, usableLength);
  }
  if (author) {
    y += titleSize / 2 + gap + authorSize / 2;
    ctx.font = `400 ${authorSize}px Georgia, 'Times New Roman', serif`;
    ctx.globalAlpha = 0.85;
    ctx.fillText(author, lengthPx / 2, y, usableLength);
    ctx.globalAlpha = 1;
  }

  return canvas;
}

/** Largest size at or below `maxSize` that fits `text` within `maxWidth`. */
function fitFont(ctx, text, maxWidth, maxSize, weight) {
  let size = Math.floor(maxSize);
  while (size > 6) {
    ctx.font = `${weight} ${size}px Georgia, 'Times New Roman', serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  return size;
}
