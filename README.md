# Athenaeum
 
A 3D reading environment for your ebooks. Athenaeum replaces the flat, scrolling page of a conventional e-reader with a physically simulated book in a visually stunning environment.
 
I've used a few ebook readers in the 2 decades I've spent alive. One thing kept coming to my mind - why are they so ugly? Everyone I know tells me they buy physical copies of books because they cannot focus for the life of them on an ebook. It makes sense. It's just a flat panel you control with the arrow keys. It's just so much nicer being able to hold the physical book in your hands, go wherever you want, and not be distracted by thousands of notifications on your computer. That's what sparked the idea for Athenaeum.

<img width="1427" height="800" alt="Screenshot 2026-09-02 113103" src="https://github.com/user-attachments/assets/f1ca017c-4455-445d-b512-3229fbb3d463" />
 
## What it currently does
 
- **Renders a real, physical book.** Pages have thickness, a bendable curl as they turn, and a spine that thickens or thins based on how many pages the book actually has.
- **Realistic page-turning.** Drag a page with the mouse and it peels up and over exactly like paper, following a curl geometry rather than a flat swap of textures. Arrow keys trigger the same physical turn animation instead of just jumping to the next index.
- **A living scene, not a viewer.** The book sits on a modeled desk beside a lamp, rendered in Three.js with proper lighting — an environment, not a UI panel.
- **Camera and book controls that stay intuitive.** Orbit around the book freely; hold Shift and drag to slide the book itself across the desk, always along the plane facing your current camera angle, so movement never feels disconnected from what you're looking at.
- **Reads reading progress physically.** The book's hinge position — how the pages are distributed left vs. right — animates smoothly as you move through it, the same way a paperback visibly thins on one side as you get further in.
- **Upload and go.** Drop in an EPUB, and the server-side pipeline converts it to a PDF and rasterizes each page into a texture that gets applied straight onto the simulated paper.
## How it works
 
- **Three.js** drives the whole scene: the book, desk, lamp, lighting, and camera.
- A custom **page simulation** (`src/Book/pageSim`) builds each page as a curved strip of geometry rather than a flat plane, so turning a page produces a genuine curl instead of a texture flip. Page count drives a square-root scaling curve that sets spine thickness, so a 20-page pamphlet and an 800-page novel don't look the same on the shelf.
- **PDF.js** rasterizes each page of the converted book into a canvas texture, which is mapped onto the correct page geometry with handedness correction so text reads right-side-up no matter which side of the spine it lands on.
- An **Express upload server** (`upload-server.ts`) accepts an `.epub`, converts it to PDF, and serves it back to the client, so the whole pipeline — from file upload to a page you can physically turn — happens without leaving the app.
- GLTF-loaded **desk and lamp models** are automatically scaled and positioned relative to the book, so the scene composes correctly regardless of the book's own dimensions.
## Getting started
 
```bash
npm install
node upload-server.ts   # starts the upload/conversion API on :3000
npx vite                # starts the dev server (proxies /api to the server above)
```
 
Then open the dev server URL in your browser, upload an `.epub` from the panel in the corner, and the book will load onto the desk once conversion finishes.
 
## Controls
 
| Input | Action |
| --- | --- |
| Left-click drag | Orbit the camera around the book |
| Left/Right arrow | Turn to the previous/next page |
| Drag a page directly | Turn that page by hand, mid-curl |
| Shift + drag | Slide the book across the desk, along the camera's view plane |
| "Flip book over" | Turn the whole book to its back cover |
| "Reset" | Return the book to its starting position and page |
 
## Status
 
Athenaeum is an active work in progress — the core page-turn physics, texture pipeline, and desk scene are functional.

Next steps:
- polishing book physics/interaction with scene
- menu UI
- additional ebook navigation tools
- AR miniature reading room
- communal reading
