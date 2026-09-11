# Athenaeum

A 3D reading environment for your ebooks. Athenaeum replaces the flat, scrolling page of a conventional e-reader with a physically simulated book in a visually stunning environment.

I've used a few ebook readers in the 2 decades I've spent alive. One thing kept coming to my mind - why are they so ugly? Everyone I know tells me they buy physical copies of books because they cannot focus for the life of them on an ebook. It makes sense. It's just a flat panel you control with the arrow keys. It's just so much nicer being able to hold the physical book in your hands, go wherever you want, and not be distracted by thousands of notifications on your computer. That's what sparked the idea for Athenaeum.

<img width="1427" height="800" alt="Screenshot 2026-09-02 113103" src="https://github.com/user-attachments/assets/f1ca017c-4455-445d-b512-3229fbb3d463" />

<img width="1912" height="949" alt="image" src="https://github.com/user-attachments/assets/96657f42-4137-4090-9884-89744bf625cc" />

<img width="1299" height="769" alt="Screenshot 2026-09-09 175649" src="https://github.com/user-attachments/assets/4382e9e4-8d42-49c4-9a6b-0ababd104988" />

## What it currently does

- **Renders a real, physical book.** Pages have thickness, a bendable curl as they turn, and a hardcover with a flat spine, French grooves at the joints and eased board edges. The spine thickens or thins based on how many pages the book actually has.
- **Realistic page-turning.** Drag a page with the mouse and it peels up and over exactly like paper, following a curl geometry rather than a flat swap of textures. Arrow keys trigger the same physical turn animation instead of just jumping to the next index.
- **The whole book obeys gravity.** It's a rigid body with cover colliders, so it falls, lands on the desk and settles on whichever board is underneath. The spine tilts as you read — and the heavier the book, the harder its own page block holds it flat.
- **A room, not a viewer.** A desk under a window, a lamp, a bookshelf against the back wall, walls and a ceiling — lit by an HDR environment map, with daylight coming in through the glazing bars.
- **A shelf you can actually browse.** The books on it are your real EPUBs: cover art, title, author and spine thickness all come from the files themselves. Hover one and it slides out; click it and it comes into your hand and follows you around the room.
- **Picking a book off the shelf opens it.** The EPUB is converted and rasterized in the background, and the finished, physically simulated book then takes the model's exact place in your hand — same size, same position, no visible hand-off. Click the desk to set it down.
- **Three ways to move.** Orbit the desk, walk the room in first person, or stand in the middle and look around with a zoom.
- **A menu for the rest of it.** Page and chapter navigation, background/scene switching, audio channels, and full hotkey rebinding.
- **Upload and go.** Drop in an EPUB and the same pipeline converts it, rasterizes each page, and applies it straight onto the simulated paper.

## How it works

- **Three.js** drives the whole scene: the book, the room, the furniture, lighting and camera.
- A custom **page simulation** (`src/book/pageSim`) builds each page as a curved strip of geometry rather than a flat plane, so turning a page produces a genuine curl instead of a texture flip. Page count drives a square-root curve that sets spine thickness, so a 20-page pamphlet and an 800-page novel don't look the same on the shelf.
- **Two Rapier worlds, deliberately.** The page mechanism runs in the book's own local frame with gravity rotated into it every frame, which is exactly what makes it unable to host the book itself — so where the book *sits* is a second world (`src/book/placement`) in world space with plain constant gravity. They're coupled one way only: placement moves the book, the book's transform tells the pages which way is down.
- **PDF.js** rasterizes each page of the converted book into a canvas texture, mapped onto the correct page geometry with handedness correction so text reads right-side-up no matter which side of the spine it lands on.
- An **Express server** (`server/uploadServer.ts`) accepts an `.epub`, converts it to PDF via Playwright, and serves it back. It also reads the shelf's library straight out of `src/books/`: `epubMetadata.ts` pulls the jacket, and `epubToc.ts` walks the reading order to measure each book's real length and work out where its chapters fall — which is what makes chapter jumps possible when the PDF itself carries no chapter marks.
- **The room measures itself.** Desk, lamp and shelf are GLTF models placed relative to each other, and the floor, walls, ceiling and window are then built onto that footprint (`src/scene/room.js`) — so swapping a model or changing the gap between desk and shelf still closes the room correctly around them.
- **Vue 3** provides the menu (`src/ui/`), backed by reactive stores in `src/state/`. The stores hold values only; `src/ui/bindSettings.js` is the single place a setting becomes an effect, so the interface never reaches into the scene.

## Getting started

```bash
npm install
npm run server   # epub -> PDF conversion + library API on :3000
npm run dev      # Vite dev server (proxies /api to the server above)
```

Put some `.epub` files in `src/books/` and they'll appear on the shelf. Then open the dev server URL, take one off the shelf, and it'll open in your hands once conversion finishes — or upload an EPUB from the panel in the corner.

The first time a given book is opened it pays the full conversion; after that it's instant.

## Controls

Every key below can be rebound in **Settings → Controls**.

| Input | Action |
| --- | --- |
| `Esc` | Open the menu — or put back the book in your hand first |
| `1` / `2` / `3` | Orbit / walk / look camera |
| `W` `A` `S` `D` | Move (hold `Shift` to run) |
| Drag | Orbit the camera, or look around in first person |
| Scroll | Zoom, in look mode |
| Click a shelf book | Take it — and open it |
| Click the book | Bring it up to read — `Esc` puts it back |
| Click the desk | Set the held book down |
| `←` / `→` | Turn to the previous/next page |
| Drag a page directly | Turn that page by hand, mid-curl |
| `Shift` + drag | Slide the book across the desk, along the camera's view plane |
| Right-drag | Turn the book — on the desk or in your hand |
| Scroll, holding the book | Bring it closer or push it away |
| `F` | Flip the book over |
| `R` | Reset the book to the desk — or, in your hand, back to how it was first held |
| `H` | Hide or show the walls and ceiling |
| `M` | Mute |

## Status

Athenaeum is an active work in progress. The page-turn physics, texture pipeline, shelf library, room and menu are functional.

Next steps:
- polishing book physics/interaction with scene
- community features (the tab is there, the features aren't)
- adding scenes and better lighting (it's not quite as visually stunning as I want it to be)
- AR miniature reading room
- communal reading
