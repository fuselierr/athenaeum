import "../lib/foliate-js/view.js";
import html2canvas from "html2canvas";
import { createPageMesh } from "./Book/pageTexture.js";

const fileInput = document.getElementById("epub-file");
const viewer = document.getElementById("epub-viewer");

// Neither of the two obvious ways to screenshot foliate-js's paginated
// (CSS multi-column) rendering works in Chromium:
//   - html2canvas has its own hand-rolled layout engine that doesn't
//     implement `column-width`/`column-count` at all — it just renders
//     everything as one tall single column, so only the first page's
//     worth of content ever shows up correctly.
//   - SVG <foreignObject> uses the real browser layout engine (so columns
//     render correctly), but Chromium unconditionally taints any canvas
//     you draw a foreignObject-containing image onto, even with zero
//     external resources — getImageData/toDataURL throw, and WebGL's
//     texImage2D refuses the same tainted canvas.
//
// Instead of screenshotting the paginated iframe directly, we ask the
// paginator which DOM Range is currently visible (it already computes this
// for its own page-progress tracking, via getBoundingClientRect checks —
// genuine browser layout, so it respects real column boundaries), clone
// just that range's content into a plain, isolated iframe of our own
// (normal block flow, no columns, no shadow DOM), and let html2canvas
// render *that* — which is exactly the case it's actually good at.
// `column-width` is set via inline style right before the page first
// renders; reading it can race that on the very first 'relocate'. Falling
// back to the clipping container's own live width (2 levels above the
// iframe — see the note above) avoids ever guessing at a hardcoded number,
// which would reflow the text narrower or wider than it actually is and
// throw off how much of it fits vertically.
function getColumnWidth(doc) {
    const fromStyle = parseFloat(doc.documentElement.style.columnWidth);
    if (fromStyle) return fromStyle;

    const iframe = doc.defaultView?.frameElement;
    const container = iframe?.parentElement?.parentElement;
    return container?.clientWidth || 480;
}

// foliate-js wraps image-only pages (covers, full-page illustrations) in
// an <svg><image xlink:href="blob:..."/></svg> rather than a plain <img>.
// The xlink:href survives cloning into the capture iframe fine, but
// html2canvas doesn't resolve SVG <image> sources at all — it just renders
// its "broken image" placeholder — so swap each one for a plain <img>
// pointing at the same blob URL, which it handles normally.
function normalizeSvgImages(root) {
    for (const svgImage of root.querySelectorAll("image")) {
        const href = svgImage.getAttributeNS("http://www.w3.org/1999/xlink", "href")
            || svgImage.getAttribute("href");
        if (!href) continue;

        const svg = svgImage.closest("svg");
        const width = svg?.getAttribute("width") ?? svgImage.getAttribute("width");
        const height = svg?.getAttribute("height") ?? svgImage.getAttribute("height");

        const img = root.ownerDocument.createElement("img");
        img.src = href;
        img.style.display = "block";
        img.style.width = width ? `${width}px` : "100%";
        img.style.height = height ? `${height}px` : "100%";

        (svg ?? svgImage).replaceWith(img);
    }
}

async function captureVisiblePage(range) {
    if (!range) return null;

    const doc = range.startContainer.ownerDocument;
    const columnWidth = getColumnWidth(doc);
    const styles = Array.from(doc.querySelectorAll("head style, head link[rel='stylesheet']"))
        .map(el => el.outerHTML)
        .join("\n");

    const captureFrame = document.createElement("iframe");
    captureFrame.style.position = "fixed";
    captureFrame.style.left = "-9999px";
    captureFrame.style.top = "0";
    captureFrame.style.width = `${columnWidth}px`;
    // Tall enough that no plausible page's worth of text gets constrained
    // before we measure its real height below.
    captureFrame.style.height = "20000px";
    captureFrame.style.border = "0";
    document.body.appendChild(captureFrame);

    try {
        await new Promise(resolve => {
            captureFrame.addEventListener("load", resolve, { once: true });
            captureFrame.srcdoc = `<!DOCTYPE html><html><head>${styles}</head><body></body></html>`;
        });

        const captureDoc = captureFrame.contentDocument;
        captureDoc.body.appendChild(captureDoc.importNode(range.cloneContents(), true));
        normalizeSvgImages(captureDoc.body);
        await captureDoc.fonts?.ready;
        await Promise.all(Array.from(captureDoc.images, img =>
            img.decode().catch(() => {})));

        // The real content height, not a guess — this is what makes sure
        // the capture below includes all of the page's text instead of
        // cutting off whatever doesn't fit in an arbitrary fixed height.
        const contentHeight = captureDoc.body.scrollHeight;
        // A relocate can fire again (moving to a further page) while this
        // capture is still in flight; by then `range` may point at nodes
        // foliate-js has already torn down for the page it left, which
        // clones as empty content. Bail rather than hand html2canvas a
        // zero-size target.
        if (!columnWidth || !contentHeight) return null;

        const rendered = await html2canvas(captureDoc.body, {
            width: columnWidth,
            height: contentHeight,
            windowWidth: columnWidth,
            windowHeight: contentHeight,
        });
        return rendered;
    } finally {
        document.body.removeChild(captureFrame);
    }
}

export function initEpubViewer(scene) {
    const { mesh, updateFromCanvas } = createPageMesh();
    mesh.position.set(0.4, 0, 0);
    scene.add(mesh);

    fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0];
        if (!file) return;

        const view = document.createElement("foliate-view");

        view.style.display = "block";
        view.style.width = "600px";
        view.style.height = "800px";

        viewer.appendChild(view);

        // Page turns can fire another 'relocate' before an in-flight
        // capture finishes; only the most recently requested one should
        // ever land on the texture, so a slow/stale capture can't clobber
        // a newer page with an old one.
        let latestRequestId = 0;
        view.addEventListener("relocate", ({ detail }) => {
            const requestId = ++latestRequestId;
            captureVisiblePage(detail.range)
                .then(rendered => {
                    if (rendered && requestId === latestRequestId) updateFromCanvas(rendered);
                })
                .catch(err => console.error("PAGE CAPTURE ERROR:", err));
        });

        try {
            await view.open(file);
            await view.next();
        } catch (error) {
            console.error("FOLIATE ERROR:", error);
        }

        document.addEventListener("keydown", async (event) => {
            if (event.key === "ArrowRight") {
                event.preventDefault();
                await view.next();
            }

            if (event.key === "ArrowLeft") {
                event.preventDefault();
                await view.prev();
            }
        });
    });
}
