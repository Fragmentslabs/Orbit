# Slides in the panel

A `slides` tab in the right panel where the agent writes a deck and the person
presents it: 16:9 stage, keyboard, slide list in the footer, speaker notes
and fullscreen. The same deck also renders INLINE in the conversation, as an
artifact, with the exits to the sidebar and to fullscreen. It is the third tab of
the same mold — Design (`canvas.json` + artboards) and Motion (composition + player)
— with a cheaper authoring contract than both.

## Status

**Implemented**, with PDF download and its own item in the gallery (Media). The deck
is **one file** (`index.html` with one `<section class="slide">` per slide), the
app injects the navigation runtime and the agent has two writing doors.

## Why one file, and not a canvas

Design is expensive to drive: `canvas.json` + one `.html` per artboard +
invented `x/y/w/h` coordinates. For a five-screen deck that is ~7 tool calls
before the user sees the first one. A slide does not need a visual editor — nobody
drags a bullet point — so the contract can be the one of an artifact: **the
whole content in one call**.

That does not take away Design's value: it remains the place to adjust position.
A slide is narrative, and narrative is written, not dragged.

## The deck contract

```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="orbit-slides" content="width=1280,height=720">
  <title>My deck</title>
  <style>/* the deck's CSS */</style>
</head>
<body>
  <section class="slide" data-title="Cover">
    <h1>Orbit</h1>
    <aside class="notes">what to SAY on this slide</aside>
  </section>
  <section class="slide"><h2>Second</h2></section>
</body>
</html>
```

- **One `<section class="slide">` per slide**, in document order. A nested section
  belongs to the slide that contains it.
- **`data-title`** names the slide in the tab's list; without it the first
  `h1/h2/h3` counts, and without a heading the label is "Slide N".
- **Notes**: `<aside class="notes">text</aside>` (the element's text counts) or
  `data-notes="text"` (the attribute's value counts). They do not show up on the stage.
- **`<meta name="orbit-slides">`** declares the stage; the default is 1280×720.
- **No JavaScript in the deck.** Navigation, scaling, list, notes and fullscreen are
  the app's — that is what makes the deck content and keeps it opening after
  any change in the tab.
- **`?print=1`** in the URL serves the same deck stacked, one slide per page — the
  basis of the PDF export, which does not exist in the interface yet.

## The tools (the same in both modes)

The deck is an Orbit piece: it lives in `orbit-data/slides/<session>/<slug>/`, in
chat and in code, and is addressed by its title (or by the `sld_…` id, from any
conversation). The user's repository only receives the deck when they ask for it
(`piece_export`).

| tool | what it does |
| --- | --- |
| `slides_write({ title, slides[] })` | creates or replaces the deck with the house theme |
| `slides_write({ title, html })` | the same, with the whole document (own theme) |
| `slides_edit({ name, edits[] })` | exact replacements in the deck's HTML — without resending everything |
| `slides_read({ name })` | the current HTML |
| `slides_preview({ name })` | reopens the tab (and reports the deck) without writing |
| `slides_asset({ name, ref \| path })` | copies an attachment (or, in code, a project file) into the deck folder |
| `slides_delete({ name })` | deletes the folder, the gallery item and the tab |

`slides_write` with `slides` builds the document with the house theme (dark
background, golden accent, large typography) and support classes — `.cover`, `.section`,
`.kicker`, `.lead`, `.grid.cols-2/3/4`, `.card`, `.stat`, `.quote`, `.pill`.
It is the fast path: one call, with no intermediate `write`.

Every write goes through the turn's media journal (`session/media-journal.ts`):
the message's revert brings the deck back to its previous state — or deletes it, if
the turn created it — and the unrevert brings it back.

All the ones that write or open return the same report: how many slides, the title of each one and which ones
have notes — read from the file in main, with no offscreen window (the deck is static
HTML, unlike motion).

## Architecture

```
electron/lib/slides/
  slides-runtime.ts   the script injected in <head>: stage, scale, keyboard, bridge
  slides-store.ts     id → folder/entry registry, orbit-slides:// scheme, watcher
  slides-open.ts      registers, opens the tab and reports the deck
  slides-gallery.ts   the cover (slide 1) and the gallery registration
  slides-deck.ts      HTML reading (titles, notes, count) — pure
  deck-template.ts    the slides_write mold (theme + assembly) — pure
electron/lib/tools/
  slides.ts           slides_write/edit/read/preview/asset/delete (both modes)
  piece-common.ts     what the three pieces share: folders, journal, asset, deletion
src/components/
  slides-tab.tsx      the tab: stage, slide list, notes and transport
  slides/use-slides-deck.ts  the bridge and the index — the SAME on both surfaces
  ai/slides-part.tsx  the inline deck in the conversation (like the artifact)
```

The `orbit-slides://<id>/<path>` scheme serves the registered folder (nothing outside
it) and injects the runtime into the HTML; `?raw` returns the source as it is on disk.
The watcher (`slides:changed`) reloads the stage when the file changes, going back
to the same slide — the same cycle as motion/design.

The bridge is postMessage with `source: "orbit-slides"` (iframe `sandbox="allow-scripts"`,
without `allow-same-origin`):

- deck → app: `ready` (total, stage, titles, notes), `change` (index),
  `error`, `request-fullscreen`
- app → deck: `go(index)`, `next`, `prev`

## Where the deck shows up

Two surfaces, a single behavior (`use-slides-deck.ts`): the panel's **tab** and the
**card in the conversation**. Each one mounts its own iframe and keeps its own
index; the `event.source === iframe.contentWindow` filter is what stops one stage
from reacting to the other's `change`.

- **Tab** — the stage takes the whole width and the list lives in the FOOTER, upright, with
  limited height and vertical scrolling; it scrolls by itself to the current slide. A
  208px column on the right ate exactly the width 16:9 needs in a narrow
  panel — in the footer the list only costs height, and only while open.
- **Chat** — the deck renders inline, like the artifact. `slides:resolve`
  registers and returns `id` + entry WITHOUT opening a tab (it is what feeds the iframe);
  from the header come the two exits: **open in the sidebar** (`slides:open`) and
  **fullscreen** (a Dialog with its own stage, which inherits the slide the card
  was on).
- **Preview and fullscreen have separate bridges** on purpose: closing the dialog
  does not restart the card, and advancing in fullscreen does not touch the preview.

## Pitfalls the test caught

1. **The runtime is the first script of the `<head>`** — it runs before `<body>`
   exists. Without waiting for `DOMContentLoaded`, `querySelectorAll('.slide')`
   returns empty and the stage is born blank. Everything that touches the document lives
   inside `start()`.
2. **The stage is bigger than the window of a narrow panel.** Grid/flex do not
   center an item bigger than the container (it leaks to the right): the stage
   is anchored at `left/top: 50%` and centered with `translate(-50%,-50%)`
   before the `scale`.
3. **`resize` is not enough.** The iframe is resized by the panel, and not every
   layout change arrives as an event in its window — hence the `ResizeObserver`
   in the viewport.
4. **The runtime string cannot have a template literal.** A backtick inside the
   script closes the module's string. There is a test that compiles the text with
   `new Function`.

## Downloading as PDF

The PDF is the **print of `index.html` itself** — there is no second format.
The runtime has a `?print=1` mode that stacks the slides (one per page, `@page`
with the stage's size), and main opens a hidden window and calls Chromium's
`printToPDF`. Same path as the document (`media.ts:renderPdf`), with no PDF
generation library in the project.

Download button in the tab's header → `slides:export` → `renderSlidesPdf`
(`electron/lib/slides/slides-export.ts`) → save dialog. Cancelling is not an
error. The suggested name is the deck's title.

### The `pageSize` unit lies

Electron's type table says a custom `pageSize` is a `Size` in
**microns**. In 44.3.0 (macOS) it is not: the value is read as **inches**, and
multiplied by 72. Verified by printing for real:

| Value passed | What comes out |
|---|---|
| `{ width: 338667, height: 190500 }` (microns) | fails: `Printing failed` |
| `{ width: 595, height: 842 }` | 595×842 **inches** page (MediaBox 60624×42840) |
| `{ width: 1280/96, height: 720/96 }` | **MediaBox `[0 0 960 540]`** — exact 16:9, no margin |

A size too large also blows a 16-bit limit of the box:
960×540 inches = 69120 pt > 65535 pt — hence the "Printing failed" instead of a
gigantic page.

Since the documentation promises one unit and the implementation uses another, the export
**measures the PDF that came out** (pdf-lib) and, if the page is not the requested size, redoes it
in the other unit. A future Electron that fixes the unit will not return a deck
of 0.35 mm: it falls into the retry. `slides-export.test.ts` pins both worlds.

## In the gallery (Media)

The deck enters as a type of its own (`kind: "slides"`), with the cover taken from the
**first slide** — and it comes out cheap: the deck is served with the injected runtime,
which mounts the stage and already shows slide 1; photographing an offscreen window of the
size declared in the meta gives the exact cover, **with no seek and no layer measurement**.

- `slides-gallery.ts` has `registerSlidesCover` and the deletion hook; whoever
  calls the registration is `slides_open`, after confirming that the deck HAS slides
  (a cover of an empty stage is no good).
- `slides_write` and `slides_edit` change the deck, so the cover is redone on every
  write (`refreshCover`); `slides_preview` only captures it when the item
  does not exist yet.
- Deleting in the gallery deletes the deck folder, with the locks of
  `deleteSlidesDeck`: the folder has to exist, contain the deck entry and be
  INSIDE the root of the chat or of the project that registered it — **never be the project**.
  The PDFs already downloaded stay.
- Clicking the tile reopens the Slides tab (the same `slides:open` as the chat card).

The cover file is `dck_<id>.png` in `artifactsDir()`, like `dsn_`/`mot_`; the
prefix is different from the deck's `sld_` on purpose, to avoid mixing the two
name spaces when debugging.

## What is still missing

- Real thumbnails in the list (the gallery already has a cover): the iframe is opaque,
  so each thumbnail would require one capture per slide. Today the list shows
  title + number, which is what you look for when navigating.
- Presenter window (notes + next slide + timer on a second screen).
- Transitions between slides.
