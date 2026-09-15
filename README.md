# Athenaeum

A 3D reading environment for your ebooks. Athenaeum replaces the flat, scrolling page of a conventional e-reader with a physically simulated book in a visually stunning environment — on a screen, or in VR.

I've used a few ebook readers in the 2 decades I've spent alive. One thing kept coming to my mind - why are they so ugly? Everyone I know tells me they buy physical copies of books because they cannot focus for the life of them on an ebook. It makes sense. It's just a flat panel you control with the arrow keys. It's just so much nicer being able to hold the physical book in your hands, go wherever you want, and not be distracted by thousands of notifications on your computer. That's what sparked the idea for Athenaeum.

<img width="1427" height="800" alt="Screenshot 2026-09-02 113103" src="https://github.com/user-attachments/assets/f1ca017c-4455-445d-b512-3229fbb3d463" />

<img width="1912" height="949" alt="image" src="https://github.com/user-attachments/assets/96657f42-4137-4090-9884-89744bf625cc" />

<img width="1299" height="769" alt="Screenshot 2026-09-09 175649" src="https://github.com/user-attachments/assets/4382e9e4-8d42-49c4-9a6b-0ababd104988" />

## What it currently does

### The book
- **Renders a real, physical book.** Pages have thickness, a bendable curl as they turn, and a hardcover with a flat spine, French grooves at the joints and eased board edges. The spine thickens or thins based on how many pages the book actually has.
- **Realistic page-turning.** Drag a page with the mouse and it peels up and over exactly like paper, following a curl geometry rather than a flat swap of textures. Arrow keys trigger the same physical turn animation instead of just jumping to the next index — and a shut book opens board first, then spread, the way a real one does.
- **The whole book obeys gravity.** It's a rigid body with cover colliders, so it falls, lands on the desk and settles on whichever board is underneath. The spine tilts as you read — and the heavier the book, the harder its own page block holds it flat.
- **Hold it like a book.** Click it and it comes up into your hands, square and framed for reading, and follows you around. Slide it, turn it, bring it closer or push it away, and set it back down on the desk wherever you click.

### The places
- **A room, not a viewer.** A desk under a window, a lamp, a bookshelf against the back wall, walls and a ceiling — lit by an HDR environment map, with daylight coming in through the glazing bars.
- **A shelf you can actually browse.** The books on it are your real EPUBs: cover art, title, author and spine thickness all come from the files themselves. Hover one and it slides out; click it and it comes into your hand.
- **Picking a book off the shelf opens it.** The EPUB is converted and rasterized in the background, and the finished, physically simulated book then takes the model's exact place in your hand — same size, same position, no visible hand-off.
- **Step outside.** A door beside the desk opens onto miles of mountain terrain built from a real heightmap: slope-textured ground, wind-blown grass and drifts of flowers that follow you as you walk, a physically based sky, raymarched volumetric clouds, height fog, auto exposure and color grading. Walk the hills, jump, sit down in the grass or lie back in it — and it parts around you.
- **Sound.** An ambient wind in the room and a meadow outside, crossfading as you go out or come back in, plus page-turn sound effects.

### Everywhere
- **VR.** Put on a headset and walk the room with the thumbsticks, pick the book up with a grip and hold it in your hand, take hold of a page with your other hand to turn it, and pull books off the shelf. The whole menu comes with you on a panel you point at.
- **Community covers.** Sign in with Google or Discord to browse jacket designs other readers have made — searchable by title, author and keywords, each shown laid flat (back, spine, front) with how many readers are using it — and put one on any book on your shelf. The shelf model and the book in your hand both wear it. Made your own? Share it.
- **A menu for the rest of it.** Page and chapter navigation, switching between the room and outside, backgrounds, audio channels, graphics quality presets from lowest to highest, look sensitivity and inversion, and full hotkey rebinding.
- **Upload and go.** Drop in an EPUB from the Book tab and the same pipeline converts it, rasterizes each page, and applies it straight onto the simulated paper.

## How it works

- **Three.js** drives the whole scene: the book, the room, the terrain, lighting and camera.
- A custom **page simulation** (`src/book/pageSim`) builds each page as a curved strip of geometry rather than a flat plane, so turning a page produces a genuine curl instead of a texture flip. Page count drives a square-root curve that sets spine thickness, so a 20-page pamphlet and an 800-page novel don't look the same on the shelf.
- **Two Rapier worlds, deliberately.** The page mechanism runs in the book's own local frame with gravity rotated into it every frame, which is exactly what makes it unable to host the book itself — so where the book *sits* is a second world (`src/book/placement`) in world space with plain constant gravity. They're coupled one way only: placement moves the book, the book's transform tells the pages which way is down.
- **PDF.js** rasterizes each page of the converted book into a canvas texture, mapped onto the correct page geometry with handedness correction so text reads right-side-up no matter which side of the spine it lands on.
- An **Express server** (`server/uploadServer.ts`) accepts an `.epub`, converts it to PDF via Playwright, and serves it back. It also reads the shelf's library straight out of `src/books/`: `epubMetadata.ts` pulls the jacket, and `epubToc.ts` walks the reading order to measure each book's real length and work out where its chapters fall — which is what makes chapter jumps possible when the PDF itself carries no chapter marks.
- **The room measures itself.** Desk, lamp and shelf are GLTF models placed relative to each other, and the floor, walls, ceiling and window are then built onto that footprint (`src/scene/inside/room.js`) — so swapping a model or changing the gap between desk and shelf still closes the room correctly around them.
- **The outdoors is mostly shaders** (`src/scene/outside`). The terrain is a displaced 16-bit heightmap with a triplanar material that picks sand, grass, rock or snow by slope and height, with distance tiling and macro variation to hide repetition. Grass and flowers are GPU-instanced in chunks that wrap around you as you walk: every chunk shares one set of blades, and the vertex shader finds the ground height, density, growth, wind and parting from a texture of the terrain — so moving a chunk costs one matrix. The sky is a Preetham atmosphere prefiltered into image-based lighting, and a post-processing chain adds volumetric clouds (Perlin-Worley noise, Beer-Lambert light marching), exponential height fog, log-luminance auto exposure and Unreal-style color grading. Leaving unloads all of it from the GPU.
- **WebXR** (`src/input/vrControls.js`) puts the camera and both controllers on a rig that the thumbsticks move and turn. Held books ride a controller through the same carry the mouse uses, pages and boards follow the hand's swing about the spine, and the Vue menu is rendered onto a mesh with three's `HTMLMesh` and pressed with the trigger.
- **Supabase** handles accounts (Google and Discord OAuth), the community covers (Postgres, with row-level security keeping each reader's library their own and a security-definer search function that counts a cover's readers without exposing who they are) and cover image storage.
- **Vue 3** provides the menu (`src/ui/`), backed by reactive stores in `src/state/`. The stores hold values only; `src/ui/bindSettings.js` is the single place a setting becomes an effect, so the interface never reaches into the scene.
- **Ambient audio never loops audibly.** `src/audio/ambientLoop.js` plays each recording on two voices that take turns: each plays a stretch from a random point, then crossfades (equal-power) into the other, so neither end of the file — nor a repeating pattern — is ever heard.
- **Deployed** as a static Vite site on Vercel, with the conversion server in Docker on Railway.

## Getting started

```bash
npm install
npm run server   # epub -> PDF conversion + library API on :3000
npm run dev      # Vite dev server (proxies /api to the server above)
```

Put some `.epub` files in `src/books/` and they'll appear on the shelf. Then open the dev server URL, take one off the shelf, and it'll open in your hands once conversion finishes — or upload an EPUB from the **Book** tab of the menu.

The first time a given book is opened it pays the full conversion; after that it's instant.

### Configuration

Both the site and the server read one `.env` in the project root. Everything in it is optional for running locally.

| Variable | Used by | What for |
| --- | --- | --- |
| `SUPABASE_URL` | site | Sign-in and community covers |
| `SUPABASE_PUBLISHABLE_KEY` | site | Sign-in and community covers (public by design — row-level security protects the data) |
| `ATHENAEUM_API_URL` | site, deployed | Where the conversion server is, once it isn't on the same origin |
| `CORS_ORIGINS` | server, deployed | Which site origins may call it, comma-separated; `*` matches within one part of a hostname |

## Controls

Every key below can be rebound in **Settings → Controls**. The round button in the top right opens the menu too.

| Input | Action |
| --- | --- |
| `Esc` | Open the menu — or put back the book in your hand first |
| `1` / `2` / `3` | Orbit / walk / look camera |
| `W` `A` `S` `D` | Move (hold `Shift` to run) |
| `Space` | Jump, in walk mode |
| `X` | Sit down, then lie down, then stand up again, in walk mode outside |
| Drag | Orbit the camera, or look around in first person |
| Scroll | Zoom, in look mode |
| Click a shelf book | Take it — and open it |
| Click the book | Bring it up to read — `Esc` puts it back |
| Click the desk | Set the held book down |
| Click the door | Go outside |
| Right-click the sofa | Sit there — anywhere on it, chaise included; move, jump or `X` to get up |
| Right-click the bench | Sit on it, outside — move, jump or `X` to get up |
| `←` / `→` | Turn to the previous/next page |
| Drag a page directly | Turn that page by hand, mid-curl |
| `Shift` + drag | Slide the book, along the camera's view plane |
| Right-drag | Turn the book — on the desk or in your hand |
| Scroll, holding the book | Bring it closer or push it away |
| `F` | Flip the book over |
| `R` | Reset the book to the desk — or, in your hand, back to how it was first held |
| `Q` | Drop the book from your hand, right where you hold it |
| `H` | Hide or show the walls and ceiling |
| `M` | Mute |
| `` ` `` | Debug overlay: hinge labels, FPS, and outside, the lighting and post-processing panel |
| `P` | Pause the simulation, with the debug overlay open |

### In VR

On a browser that can show VR (a headset's own, or a desktop one with a headset attached), an **Enter VR** button appears at the bottom of the screen.

| Input | Action |
| --- | --- |
| Left stick | Walk, the way you are facing |
| Right stick | Turn, in steps |
| Grip, near the book | Pick it up — it stays in your hand where you took it |
| Grip, near a shelf book | Take it off the shelf — and open it |
| Grip on a page, book in the other hand | Take hold of the page; carry your hand over the spine to turn it |
| Grip on a board, book in the other hand | Swing the cover open or shut |
| Let go of the grip | Drop the book — or, by its slot, put a shelf book back |
| `Y` (left hand) | Open or close the menu |
| Trigger | Press what your pointer is on, on the menu |
| Stick, pointing at the menu | Scroll it |

## Status

Athenaeum is an active work in progress. The page-turn physics, texture pipeline, shelf library, room, outdoors, VR, community covers and menu are functional.

Next steps:
- polishing book physics/interaction with scene
- adding scenes and better lighting (it's not quite as visually stunning as I want it to be)
- AR miniature reading room
- communal reading

## Credits

- ["sofa"](https://sketchfab.com/3d-models/sofa-33a982d268d749ddb803263ea7da84b0) by MaX3Dd, licensed under [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
- ["Park Bench"](https://sketchfab.com/3d-models/park-bench-84426d6537ac4cdc837d602ccabe7036) by DutraBR98, licensed under [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
