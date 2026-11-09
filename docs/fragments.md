# Fragments

Orbit's custom pages: a **Fragment** is a light screen, created and edited on the
spot with the agent, that stays available inside Orbit and bridges Orbit to systems
outside it — databases, APIs, local servers, MCP integrations. No project, no
visible build, no deploy.

> The fragment is the window; the system is outside. Whoever needs a backend,
> processes or heavy logic builds an app — and the fragment connects Orbit to it.
> A lot of things do not need an app of their own: a dashboard over a database, a
> screen that joins two integrations, an exercise game run by the agent, a
> generation tool. That is what Fragments are for.

**Status:** the MVP (section 2) is implemented. Everything marked *planned* is a
decision already taken but not built. The last section lists what is still open.

---

## 1. The pattern: three pieces and one rule

1. **Screen** — a front end in a sandbox. The only place with the fragment's code.
2. **Declared connections and queries** *(planned)* — the fragment writes no
   backend. It declares what it needs (connections, hosts, MCP tools) and Orbit
   executes it.
3. **Orbit as a service** — AI, storage, and (planned) HTTP, MCP and surfaces.

**The rule: nothing runs outside the screen, nothing happens without being declared,
and whoever executes is always Orbit.**

Principles that follow from it:

- **Simple:** one manifest, one folder, no build the user has to see.
- **Safe:** everything declared and reviewable at install time; secrets never enter
  the fragment; sandbox from day one, so community code needs no redesign later.
- **Standard:** native, user-made and community fragments use the same manifest and
  the same SDK. Ours get no extra privilege.
- **Does not break Orbit:** a misbehaving fragment can only take itself down.
- **Tools, not components:** Orbit offers primitives (`orbit.ai`, `orbit.store`…);
  the fragment builds whatever interface it wants.
- **The agent asks, the user grants.** The agent can *request* a capability. Only
  the user can allow it, from the UI. This blocks the agent (or anything that
  injected a prompt into it) from granting itself access.

## 2. What exists today (MVP)

Built to make the interface visible and functional, with live editing and a first
bridge between Orbit and the fragment.

| What | Where |
|---|---|
| Shared types, `FRAGMENT_SCHEME` | `packages/shared/src/fragments.ts` |
| Store on disk (manifest, files, `orbit.store` data, console log ring) | `apps/desktop/electron/lib/fragments/fragment-store.ts` |
| `orbit-fragment://` scheme: serves `src/`, closed CSP, injects SDK + theme tokens | `…/fragments/fragment-protocol.ts` |
| `window.orbit` SDK (injected script) | `…/fragments/fragment-sdk.ts` |
| Broker: checks method, declared capability, user grant, budgets | `…/fragments/fragment-bridge.ts` |
| IPC: list, get, call, grant, remove, log, update events | `…/fragments/fragment-ipc.ts` |
| Model used by `orbit.ai` (the last one the user chatted with) | `…/fragments/session-model.ts` |
| Agent tools `fragment_*` | `apps/desktop/electron/lib/tools/fragment.ts` |
| Panel tab, picker of existing fragments, iframe + courier (shared with the page) | `apps/desktop/src/components/fragment-tab.tsx` |
| Fragments page: gallery, creation canvas, fragment screen with header and edit mode | `apps/desktop/src/components/fragments/` |
| Fragments mirror (list, active fragment, creation state) | `apps/desktop/src/stores/fragments-store.ts` |
| Tab plumbing, sidebar entry, panel "Open" hub cards | `src/stores/panel-store.ts`, `src/components/right-panel.tsx`, `components/app-sidebar.tsx` |
| Tests | `…/fragments/fragments.test.ts`, `…/fragments/fragment-sdk.test.ts` |

What the MVP does:

- The agent creates and edits a fragment with `fragment_create`,
  `fragment_edit_file`, `fragment_write_file`, `fragment_read_file`,
  `fragment_delete_file`, `fragment_list`, `fragment_set_ai`, `fragment_logs`. They
  work in the normal chat, in both chat and code mode. Every write bumps the
  fragment's `revision`, the tab reloads, and the page's console/errors come back to
  the agent through `fragment_logs`.
- A fragment has a **kind** (`screen`, `panel`, `widget`) and two **pins**
  (`sidebar`, `panel`). The kind is the default placement; the pins decide where it is
  reachable. Screens are pinned to the sidebar on creation, panel fragments to the
  panel's "Open" hub; widgets are only recorded (the home-screen widget host is not
  built yet).
- **Fragments page** (sidebar): a gallery with search and a kind filter, and a
  *New fragment* action. Pinned fragments get their own row under the sidebar entry.
- The fragment also opens in a **panel tab** next to the conversation (and the "+"
  selector lists the existing ones; panel-pinned ones are cards in the "Open" hub).
- The page talks to Orbit through `window.orbit`: `store`, `ai.generate`, `theme`,
  `on('theme')`.
- `orbit.ai` needs the fragment to *ask* (`usesAi`) **and** the user to turn it on
  with a button in the tab. Budget: 12 calls/minute and 2 in flight per fragment.

Added after the MVP (all of it checked with typecheck, lint and tests only, not in the real window):

| What | Where |
|---|---|
| Provenance record (outside the fragment folder, derived owner) | `…/fragments/fragment-provenance.ts`, `packages/shared/src/fragment-provenance.ts` |
| Details panel: weight, settings, capabilities, token spend, local database, packages, origin | `…/fragments/fragment-details.ts`, `src/components/fragments/fragment-details-panel.tsx`, `…/details/` |
| Data view (read-only keys and values of `orbit.store`) | `getFragmentData`, `details/fragment-data-dialog.tsx` |
| Inspect mode (pick an element, attach it to the next message) | `…/fragments/fragment-inspector.ts` (page side), `FragmentFrame` + `fragments-store.pickElement` (host side), `src/lib/browser-selection.ts` (shared with the code composer) |
| Home-screen widgets (third pin `home`, read-only live cards) | `src/components/fragments/home-widgets.tsx`, `FragmentPreview` (`readOnly`, `fit="aspect"`) |
| `orbit.models` and the `models` capability | `…/fragments/fragment-models.ts`, `fragment-bridge.ts`, tool `fragment_set_models` |
| Per-turn history and revert of the agent's file writes | `…/fragments/fragment-history.ts`, `details/fragment-history-dialog.tsx` |

See section 6 for how the page works. Deliberately **not** built yet: connections and a secret vault, declared queries,
`refresh`/`alerts`, `orbit.http`, MCP, packages, global toast host, import/export (and so the third-party
side of provenance has no writer yet).

## 3. Anatomy on disk

```
orbit-data/fragments/<id>/
  manifest.json     the contract (section 4)
  src/              what the scheme serves; index.html is the entry
  data.json         the fragment's own state (orbit.store) — never served
  packages.lock.json  (planned) resolved dependency tree (section 8)
  .history/         one file per agent write: the file as it was BEFORE it (section 12)

orbit-data/fragment-provenance/<id>.json   where the fragment came from; outside the
                    fragment folder on purpose and never exported (section 11)

orbit-data/packages/          (planned) shared package cache (section 8)
  <name>@<version>/
```

Code and data are separate on purpose: rewriting the code never touches what the
user's fragment saved; exporting "without data" is trivial; the scheme can never
hand `data.json` or the manifest to the page because it only serves `src/`.

`<id>` is `frag-<slug>-<hex>`: lowercase letters, digits and hyphens, because it is
a URL host (`orbit-fragment://<id>/`).

Native fragments (planned) live in `resources/fragments/`, read-only, with a
"Duplicate to customize" action.

## 4. Manifest

**Today** (`FragmentManifest`):

```json
{
  "id": "frag-expense-tracker-a1b2c3",
  "name": "Expense tracker",
  "sdk": 1,
  "requests": ["ai"],
  "grants": [],
  "revision": 7,
  "createdAt": 0,
  "updatedAt": 0,
  "sessionId": "…"
}
```

`requests` is written by the agent; `grants` only by the UI. Dropping a request also
drops its grant. Capabilities today: `ai` (call the model) and `models` (the fragment
offers the model choice in its own screen). `pinned` has three flags: `sidebar`, `panel`
and `home` (a small card on the home screen; on by default for the `widget` kind).

**Target (v1)** — what the manifest grows into:

```json
{
  "id": "dev.acme.orders",
  "name": "Orders",
  "icon": "chart",
  "version": "1.0.0",
  "sdk": 1,

  "surfaces": { "page": { "entry": "src/index.html" }, "panel": { "title": "Orders" } },

  "dependencies": { "recharts": "^2.12", "axios": "^1.7" },

  "network": ["api.github.com"],

  "mcp": {
    "acme": { "description": "Acme's MCP server", "tools": ["list_orders"], "mode": "read" }
  },

  "permissions": { "ai": true, "toast": true }
}
```

Rules:

- Only one surface is required; everything else is optional.
- `id` is reverse-namespaced for shared fragments (`dev.<author>.<name>`); native
  ones use `orbit.<name>`.
- `sdk` is the major version of the `orbit.*` API the fragment expects. Orbit
  refuses a higher major and stays compatible within the same major.
- **Every capability used in code must be declared. The broker refuses the rest.**
- `dependencies` holds **direct** dependencies with ranges. Exact versions and
  hashes live in the lockfile (section 8).

## 5. SDK `window.orbit`

Injected by the scheme at the top of `<head>`, so it exists before any script of the
fragment. Every call is a `postMessage` to the tab that hosts the iframe, which
forwards it to the main process.

**Implemented**

| API | Purpose |
|---|---|
| `orbit.store.get/set/delete/keys` | Persistent JSON key-value (≤256KB per key, ≤500 keys, ≤2MB total) |
| `orbit.ai.generate({ prompt, system? })` → `{ text }` | The user's own model. Needs `ai` requested + granted. Rejects with `err.code` |
| `orbit.models.list/get/set` | The fragment's own model picker for `orbit.ai`. Needs `models` requested + granted. `list` returns only connected, text-producing models (`providerId`, `providerName`, `modelId`, `name`, `reasoning`); `set` is re-checked against that list in the broker; `set(null)` follows the chat again |
| `orbit.theme`, `orbit.on('theme', fn)` | Current theme; the Orbit CSS variables are already defined |
| (automatic) console + errors | Forwarded to the tab, readable by the agent with `fragment_logs` |

**Planned**

| API | Purpose |
|---|---|
| `orbit.http.fetch(url, init)` | Network through Orbit, only for declared and approved hosts (section 9) |
| `orbit.mcp.call(server, tool, args)` | Tools of an MCP server the user has connected, declared in the manifest (section 10) |
| `orbit.query(name, params)` | Declared queries (database connections) |
| `orbit.data.*`, `orbit.files.*` | Document collections and binaries (beyond key-value) |
| `orbit.agent.run / handle` | The Orbit agent with the fragment's own tools |
| `orbit.ui.toast / openSurface`, `orbit.chat.open` | Global toast, surfaces, open a chat with context. `chat.open` only pre-fills, never sends |
| `orbit.voice`, `orbit.image` | Existing TTS/STT and image generation |

Errors from `orbit.*` always carry a `code` (`permission_denied`, `rate_limited`,
`no_model`, `invalid_params`, `unknown_method`, `not_found`, `timeout`, …).

## 6. Surfaces

| Surface | Status |
|---|---|
| **Panel tab** (`TabType "fragment"`) | Implemented. One tab per fragment per conversation; an empty picker tab is reused |
| **Page** (`WorkspaceView "fragments"`): gallery + one fragment per screen, pinnable in the sidebar | Implemented |
| **Global toast** rendered by Orbit, outside the fragment | Planned (Orbit has no global toast host yet) |
| **Widgets** on the home screen | Implemented: the `home` pin shows a small live card under the welcome invitation. The card is a read-only frame (see below) and a click opens the fragment. Not "from cache" yet: the page runs, there is no `refresh` |

### The Fragments page

**Gallery.** A grid of cards, each with a **live thumbnail** of the fragment (the real page,
scaled, read-only: it mounts only when it scrolls into view and every `window.orbit` call
is refused, so a card can never spend tokens or write data just by being on screen).
Fragments pinned to the sidebar or the panel come first. Search, filter by kind, and a
*New fragment* action.

**Creating** is an empty canvas with the prompt in the middle — not a modal and not a card in
a chat: a heading ("Create a screen with Orbit"), the prompt, where it lives (screen /
side panel / widget) and a few starting points that fill the prompt. Sending shows the
**creating screen**: the persona thinking, a shimmering line that cycles through phases
("Creating…", "Laying out the screen…", …) and, quieter, what the agent is really doing.
The moment the first version exists it turns into the live fragment.

**The fragment screen** fills the whole area: no border and no header of its own. The app
header carries back, the fragment's **icon** (click to pick another from the Lucide set) and
its **name** (click to rename), followed by a menu of the fragment's actions (pin to the
sidebar, show in the panel's "Open" list, open in the side panel, delete). On the right of the
header are the controls: a spinner while an agent works on it, the model of `orbit.ai` and the
AI on/off switch (only when the fragment asks for it), reload and **Edit**. A request for the
model shows as a floating badge at the top of the fragment. **Edit mode**
docks Orbit's prompt at the bottom edge (collapsed, it opens on hover — the composer Design
and Motion use) and opens the **activity feed** on the right, which lists what the agent is
doing ("Editing style.css", "Checking the page for errors"). The frame reloads on every
write.

**The fragment's chat is lean and invisible.** Opinion that became design: a fragment does
not need a conversation on screen, it needs an agent that knows how to build one page. So
each fragment gets its own chat (`SessionInfo.fragment`) that:

- uses a **minimal system prompt** (`fragmentSystemPrompt`) instead of Orbit's usual one;
- gets **only the fragment tools** — no files, shell, browser, media or catalog;
- receives **no memories, skills or subchat blocks**;
- is told, every turn, **which fragment it is looking at** (id, kind, files, what was
  asked and allowed) — so a fresh chat editing an old fragment starts oriented, with no
  briefing message;
- is **hidden from the chat list**; the full conversation opens on demand in the side panel
  ("See the conversation"), and is where a failure is diagnosed.

The profile is decided in the main process from the session on disk
(`fragmentProfileOf`), never trusted from the UI.

**Icon.** A fragment has a lucide icon (kebab-case name). The agent picks one when it
creates the fragment; the person can change it. It shows in the header, the gallery, the
sidebar row and the panel's "Open" card. Unknown or malformed names fall back to a
generic window icon, so a wrong guess never breaks the manifest.

What the screen deliberately leaves out, and why:

- **Data from queries** (the SQL behind the fragment): hidden until fragments have
  queries; it should appear only for fragments that declare any. (The read-only view of
  what the fragment saved with `orbit.store` exists, in the details panel.)
- **Share/export**: waits for the package format (section 11).

**Inspect, details and history.** The header has an **Inspect** button: the page highlights the
element under the pointer and the click becomes the same attachment the panel browser makes for
a selected element (`BROWSER_SELECTION_MIME`, now serialized in one place for both composers),
opens edit mode and waits for the instruction. The picker is a small script injected next to the
SDK (the page is an opaque origin, so the host cannot read its DOM); it is dormant until the host
asks, and the host accepts a pick only while inspect mode is on. The **Details** button opens a
panel with weight (code, data, history), settings, capabilities requested and granted (the only
place besides the banner and menu where the user allows or revokes), what the fragment's chats
spent, the keys of its local database (with a read-only *View data* dialog), third-party
packages (always empty today), the **history** dialog and the provenance.

**Read-only frames.** A widget on the home screen runs the page in a frame that only forwards
`store.get` and `store.keys` (`FRAGMENT_READ_ONLY_METHODS`); everything else is refused by the
courier with `read_only`, so a card never spends tokens or changes data by being on screen.
Gallery thumbnails stay stricter: `preview` refuses every call.

**Model per fragment.** Two modes. *Header* mode — the person picks the model of `orbit.ai`
for this fragment in the header (default: the model of the chat), and its **thinking level**, next to it (`reasoning` in the manifest, applied to every `orbit.ai` call; the agent that edits the fragment has its own model and thinking in the edit prompt). *App* mode
(implemented): the fragment's own UI offers the choice through `orbit.models`. A fragment declares
it by requesting the `models` capability (the agent's tool `fragment_set_models`); once the user
allows it, the header's model and thinking controls disappear for that fragment. Not decided yet:
the thinking level has no `orbit.models` call, so in app mode it is left at what the person last
set in the header.

Contextual panel tabs (a fragment that receives the current session/folder, with a
declared and granted `context`) are a planned follow-up.

## 7. Runtime and security

### Isolation (today)

- The fragment runs in an `<iframe sandbox="allow-scripts">` **without**
  `allow-same-origin`: an opaque origin with no access to the Orbit window, cookies
  or storage. No popups, forms, top navigation, or device permissions.
- The scheme serves a **closed CSP**: scripts/styles only from the fragment itself
  (and inline), images/fonts only from itself or `data:`/`blob:`, `connect-src
  'self'` (its own files only), no frames, no forms. No CDN, no network.
- **The courier is checked three ways.** A message is forwarded only if it comes
  from *this* iframe's window, carries the token of *this* load (a page that
  navigated away does not know it), and the fragment id is the tab's — never read
  from the message.
- **The broker** (`fragment-bridge.ts`) accepts only known methods (an own-property
  check, so `constructor`/`__proto__` do not slip through), requires the capability
  to be both *declared* and *granted*, and enforces budgets.
- Path safety: absolute-looking paths are made relative to `src/`, `..` and hidden
  names are refused, only an allowlist of extensions is served
  (`html css js mjs json svg txt csv md`).

### Why an iframe and not a `WebContentsView`

The first plan used a `WebContentsView` for a separate process. Native views sit
above the DOM, so Orbit's modals, menus, global toast and drag handles would render
*behind* the fragment. The artifact already uses a sandboxed iframe, so the MVP
follows it. A spike should compare iframe vs `<webview>` vs `WebContentsView` for
crash isolation, stacking order and memory before the fragment count grows.

### Threats the design has to keep covering

- **Exfiltration through combined permissions.** A fragment that reads a database
  (MCP/query) *and* can reach the internet or the model can send the data out via
  prompts or search. The install review must show the **combination**, not only the
  list of capabilities.
- **Prompt injection.** Anything that comes back from a database, API or MCP tool is
  untrusted data. This includes the result of a test query returned to the agent.
- **The agent must never grant.** Permission changes happen only through UI actions;
  a changed manifest shows a diff and asks again.
- **`mode: "read"` is not a guarantee by itself.** Enforce it at execution: read-only
  transactions, read-only SQLite handles, timeouts, no multi-statements. In `http`
  queries, encode path placeholders and block `..` and redirects to other hosts.
- **Cost.** Beyond calls per minute, a token/cost budget per fragment.
- **Data at rest.** Cached query results are plaintext in the fragment's data;
  "export with data" must exclude the cache, and unbinding a connection clears it.
- **CPU.** A time/CPU budget per fragment; hibernate the oldest when too many are
  open.

## 8. Packages (planned)

The model: **Orbit's own capabilities are the "native modules"** (like Expo Go's
fixed native set — `orbit.*`, versioned by `sdk`); **third-party JavaScript packages
are npm packages that run in the browser.** Native addons and Node-only packages
(`fs`, `net`…) are out. This is also why no fragment can ship native code.

### How it works without `npm install`

npm is just an HTTP API plus tarballs. Orbit does the same in the main process,
without needing npm on the machine:

1. **Resolve.** `GET registry.npmjs.org/<name>` returns every version with its
   tarball URL and an integrity hash (sha512). Pick the version that satisfies the
   range in `dependencies`.
2. **Download and verify.** The tarball is checked against the hash and discarded if
   it does not match.
3. **Extract to the shared cache.** `orbit-data/packages/<name>@<version>/`.
   **No install scripts ever run** (`preinstall`, `postinstall`…), which removes
   npm's biggest risk.
4. **Follow indirect dependencies**, repeating for each one.
5. **Write the lockfile** (`packages.lock.json`) in the fragment's folder: the full
   resolved tree, with exact versions and hashes. It makes the fragment reproduce
   the same on another machine or in six months, and it is what travels with an
   exported or imported fragment.

Use npm's own libraries inside the app (`pacote` for download/verify, possibly
`arborist` for the tree) with scripts disabled, rather than writing a resolver.

### Manifest vs lockfile vs cache

| | Role |
|---|---|
| `manifest.dependencies` | Direct dependencies, version **ranges** (what the fragment wants) |
| `packages.lock.json` | The whole resolved tree, **exact** versions + hashes (what it gets) |
| `orbit-data/packages/` | **Shared, content-addressed cache**: one copy of `axios@1.7.2` for every fragment that uses it. Not a per-project `node_modules` |

Exporting a fragment carries the manifest and the lockfile, never the packages.

### Bundling

A bundler (esbuild) in the main process bundles the fragment's code and its
packages into a file the scheme serves from `'self'`, so the CSP stays closed and no
CDN is needed. It also enables TSX/JSX, picks each package's `browser` build
(dropping Node-only parts), and reports build errors back to the agent. esbuild is
not a dependency of the desktop app today (it only comes indirectly through vite),
so production needs the binary shipped outside the `asar` per architecture, or the
slower wasm build.

### Trust tiers and consent

1. **The Orbit set** — a curated, pre-bundled, pinned set (React, a charting
   library, the Orbit UI kit). No warning.
2. **Third-party packages** — any other package triggers a **consent card** on first
   install and on **any change to the lockfile**.

The card lists the **resolved tree**, not just the manifest: a manifest that says
`axios` really means `axios` plus its indirect dependencies, and that is where risk
usually sits. Show direct packages highlighted, the count of indirect ones, and the
full list when expanded, with name, version and size; state that install scripts are
disabled, and show the fragment's other requests (hosts, MCP tools, AI) next to it.

The agent can only *request* a package: when the code imports something that is not
installed, the tool returns "package pending approval" and the card appears for the
user. The same rule as `orbit.ai`.

A package already in the cache that the user approved before does not ask again; a
changed lockfile does.

### Limits

A malicious package inside the sandbox cannot touch files or the network, but it
runs with everything the fragment has: its data, the model if granted, and (later)
MCP tools. Hence the card, the CPU budget, and the permission summary next to it.

## 9. Network through Orbit (planned): the `axios` case

`axios` can be downloaded and bundled, but inside the fragment it cannot reach the
internet, because the CSP blocks it. By design: otherwise any package could send the
user's data away. The way out is for the network to pass through Orbit, like AI does:

- The manifest declares hosts: `"network": ["api.github.com"]`.
- The consent card shows "this fragment accesses api.github.com".
- The fragment gets `orbit.http.fetch`, executed in the main process **only for the
  approved hosts**, blocking internal addresses (`localhost`, private ranges) unless
  explicitly declared, with time and size limits.
- Orbit exposes this as the page's `fetch`, so libraries that use `fetch` work
  unchanged. `axios` has an `adapter: 'fetch'` mode for exactly this. Libraries that
  open WebSockets or use `XMLHttpRequest` directly stay out until Orbit has an
  equivalent capability.

## 10. Distribution through MCP: the `fragments` tool (planned)

**The idea:** people who build an MCP server for a personal or open-source project
add a `fragments` tool to it. The tool points to a **public repository** that holds
the fragment. When a user connects an integration that has this tool, Orbit offers
to install the fragment. No marketplace: the fragment travels with the integration
that gives it meaning, and discovery happens at the moment it is relevant.

Projects can carry an "Orbit Fragments" badge, backed by a short **open
specification** (the manifest format and the tool contract) in a repository of its
own. Check name conflicts before investing in the brand: "Fragments" alone is a very
common word.

### Contract (proposal)

The tool takes no arguments (or only `{ sdk }`) and returns:

```json
{
  "fragments": [
    {
      "name": "Orders",
      "description": "Last 30 days of orders",
      "repo": "https://github.com/acme/acme-mcp",
      "path": "fragments/orders",
      "ref": "<full commit sha>",
      "sdk": 1
    }
  ]
}
```

`ref` must be a **commit SHA** (content-addressed), never a branch or tag. Prefer an
MCP *resource* or server metadata over a tool if the protocol allows it, because a
tool shows up in the list the model sees. If it stays a tool, Orbit hides it from the
agent. It is also worth checking what the MCP ecosystem has already standardized for
servers that ship UI before inventing a parallel format.

### Detection and install flow

1. **Orbit's own code detects it, not the model.** When an integration connects (or
   on a refresh), Orbit reads the server's tool list, calls `fragments` if present,
   and validates the result against a strict schema.
2. The result is **untrusted data.** The agent never decides to download anything and
   nothing installs automatically.
3. A **card in the interface** offers the fragment: name, author/source, the pinned
   commit, what it requests (AI, hosts, MCP tools, packages — with the resolved
   tree). Only the user's click installs it.
4. Orbit downloads **that commit** of the repository, validates the package, checks
   that its `mcp` requirement matches the connected server, and binds the fragment to
   it.
5. **Updates** are never silent: a new `ref` shows a diff of the manifest and the
   lockfile and asks again. A server that changes its answer later cannot swap the
   code under an already-accepted fragment.
6. "Don't suggest again" is remembered per server.

### Using the server's tools from the fragment

The manifest's `mcp` block names the tools the fragment calls (`orbit.mcp.call`).
They are read-only by default; write tools need their own permission. The user binds
the fragment's `acme` to the server they actually connected, and the call runs in the
main process with the user's credentials. This is where the real risk is (a
third-party fragment driving a tool with the user's access), so the card must list
the exact tools and whether any can write.

### Import without an MCP server

Not every fragment belongs to an integration (a timer, a game, a utility). Importing
by repository URL uses the same package format, pinning and consent. A curated list
in a plain GitHub repository gives discovery without building a platform.

## 11. Package format and import/export (planned)

An exported fragment (`.orbitfrag`, a zip) holds `manifest.json`, `src/` and
`packages.lock.json`. Never the packages, never `data.json`. Export offers "with
data" (backup) or "without data" (to share). Uninstall asks whether to keep the data.

This format is the base for repository import, the MCP flow and a future registry,
and it is built first because everything else reuses it. It must carry
`dependencies` and `network` from the start.

### Provenance (record and UI built; no import yet)

Where a fragment came from is a record **kept by Orbit, outside the fragment folder**
and never exported. Nothing inside the package can claim an origin, because whoever
packs it would choose what it says.

- **Local:** created in this Orbit through the creation flow. No owner is shown, only
  "created on this computer".
- **Third party:** anything that arrived from outside (MCP, link, repository, file).
  The record keeps the source URL, how it arrived and when. A fragment exported from
  one Orbit and imported in another is third party there: the import is what decides,
  so nothing can import itself as local.
- **Owner is derived, never typed:** from `github.com/fracta/app` the owner is
  `fracta`. The source URL doubles as the link to the main app. A loose file with no
  URL Orbit fetched itself is shown as "Imported file", with no derived owner.
- **Editing a third-party fragment** does not make it local. The record notes it was
  modified and keeps the original commit, for "changed since origin".
- **Details panel:** built (see section 6). It shows weight, settings, capabilities requested and
  granted, token spend, the local database, third-party packages (when any) and this provenance.

**What exists:** `fragment-provenance.ts` keeps `orbit-data/fragment-provenance/<id>.json`. Only
`createFragment` writes `local`; `recordThirdPartyProvenance` (source URL Orbit fetched, arrival,
commit) and the "modified since origin" mark on edits are built and tested but have no caller until
import exists. The owner is never stored: `deriveOwner` computes it when the record is read. A
fragment with no record reads as local, which is true for everything created before import; the
import flow must write its record **before** the fragment appears so that fallback can never
mislabel an import.

### Install from the terminal: `npx` (planned)

```bash
npx orbit-fragments add github:fracta/app
npx orbit-fragments add https://example.com/app.orbitfrag
```

The CLI installs nothing by itself. It hands the request to the running Orbit
(`orbit://import?url=...` or a local port Orbit listens on). Orbit downloads,
verifies and writes, so the provenance record is born as third party with the URL
Orbit fetched. If Orbit is closed, the link opens it and the request waits.

- **Consent card before installing:** derived owner, pinned commit, capabilities
  requested and third-party packages. Nothing is granted on install.
- **The terminal asks, the interface confirms:** a command pasted from a README must
  never install code unseen.
- **Needs first:** the `.orbitfrag` format and URL import inside Orbit, resolving
  `github:owner/repo` to a pinned commit with integrity check, the provenance record,
  and the tiny `orbit-fragments` package on npm. Reserve the npm name early so a
  look-alike cannot be published.

## 12. Creating and editing live

Done in the normal chat with the `fragment_*` tools; the fragment tab reloads on
every write. The tool descriptions teach the agent the SDK and its limits (no
network, no CDN, vanilla JS, Orbit CSS variables, read `fragment_logs` after
writing).

**History and revert (implemented).** Every write the agent makes is a revision in `.history/`: the
file as it was before the write (`null` when the write created it), tagged with the agent turn
(`createFragmentTools` is built once per turn, so its writes share a turn id). The history dialog
lists turns newest first; *Undo from here* restores the files as they were before that turn and
drops it and every later turn (the history is a line, not a tree). Only the person reverts; the
agent has no tool for it. It keeps the last 80 revisions and 12MB, and failing to keep history
never fails a write. Known limits: the person's own changes (name, pins, grants) and the data the
page saves are not versioned; a revert is not atomic against an agent write happening at the
same instant.

Planned: a dedicated split view (live preview + chat
bound to the `fragmentId`); `fragment_test_query` for declared queries; suggesting a
fragment when an official integration connects (for example a task summary after
connecting Fracta), as **prompt templates** rather than prebuilt fragments, so the
result adapts to the person's real data.

See [specialist-agents.md](specialist-agents.md) for extending this lean profile to
Design and Motion, where these chats appear, and user-made agents.

## 13. What stays out (a case for an app)

- Receiving connections: webhooks, serving an API, bots that answer messages.
- Running commands or processes on the computer.
- Heavy processing (video, local models, bulk data).
- Code running in the background.
- A relational database of its own.

Other gaps are solved by a **new declared capability in Orbit, never by free code**:
real time (stream on `orbit.http`), local files (a `folder` connector where the user
picks the folder), Docker, embedding sites (`frame-src` allowlist), hardware (one
capability at a time), reading chats/memories (`orbit.sessions` / `orbit.memory`
with permission), scheduling with the agent (Routines bridge).

## 14. Ideas registered

Dashboards over local or remote databases; integration panels joining two or more
sources; games and exercises run by the agent; voice generation with `orbit.voice`
or an external TTS server through `orbit.http`; task summaries from official
integrations; contextual tabs beside the chat; home-screen widgets; a mobile
companion showing fragments.

## 15. Phases

| Phase | Delivery |
|---|---|
| **MVP (done)** | Scheme + sandboxed iframe + closed CSP; `orbit.store`, `orbit.ai`, theme, console logs; `fragment_*` tools with live reload; panel tab and picker; user-granted AI |
| **MVP 2 (done)** | Fragments page in the sidebar: live-preview gallery, creation canvas with starting points, the creating screen, full-bleed fragment with its controls in the app header, edit mode with activity feed; kinds, pins, icons; per-fragment model; the lean fragment chat |
| **2 — Package format** | Manifest v1 (`dependencies`, `network`, `mcp`), lockfile, `.orbitfrag` import/export, import by URL with commit pinning and the consent card, provenance record, details panel, `npx orbit-fragments add` |
| **3 — Bundler and packages** | esbuild in main, shared package cache, Orbit set, third-party packages with consent, TSX |
| **4 — Network and MCP** | `orbit.http` with host approval; `orbit.mcp` (read-only first) |
| **5 — Discovery** | `fragments` tool detection on integration connect; curated list; the spec repository and badge |
| **6 — Surfaces and history** | Page in the sidebar, per-turn history and revert, widgets (done); global toast, `refresh`/`alerts` (planned) |
| **Later** | Declared queries and database connections (possibly through MCP), community registry, mobile |

## 16. Open questions

- **Isolation:** iframe vs `<webview>` vs `WebContentsView` — measure crash
  isolation, stacking and memory, and how many live fragments before hibernating.
- **MCP shape:** tool vs resource vs an existing UI standard; one contract for the
  Orbit-side detection.
- **Declared queries:** the manifest-level SQL vs MCP tool calls, trading
  reviewability for reach.
- **`when` conditions of alerts:** prefer a small structured form
  (`{ "rows": { "gt": 0 } }`) over a string language; alerts need edge-triggered or
  cooldown semantics or they will spam, and they only run while Orbit is open.
- **Data format across versions:** `store` has no schema, so no migrations; a new
  version may expect other shapes. Either the code tolerates old shapes
  (recommended to the agent) or an `onUpgrade` hook.
- **Data shared between fragments:** probably a `data.read:<other-id>` permission.
- **Package cache:** which libraries come in the Orbit set; wasm vs native esbuild;
  respecting a user's `.npmrc` / private registry.
- **Kit `orbit-ui`:** exact format and how to version it with `sdk`.
- **Scope of the MVP's `orbit.ai` model:** the last chat model is a pragmatic choice;
  a per-fragment choice may be wanted.
- **Not verified:** everything above has been checked with typecheck, lint and tests
  (including the SDK and the inspector running in a simulated page), but not by driving the
  real Electron window — including the Fragments page, the details panel, inspect mode, the
  home-screen widgets, `orbit.models` and the history dialog.
- **Widgets:** the home-screen row exists and runs the live page; there is no cached,
  refreshed snapshot yet, so a widget that needs the model or the network shows its empty state
  there. `refresh` is what would fix that.
- **Inspect on a page that re-renders:** the picked selector is a best effort (id, classes,
  `nth-of-type`, five levels); a page that rebuilds its DOM may need the agent to find the element
  by its text and html, which the attachment carries.

## Runtime: `orbit.http`, `orbit.mcp` and the data/open tools

Two more capabilities, declared in the manifest, enforced in the main process and allowed only by the person (same flow as `ai` / `models`: the agent *asks*, the tab shows an Allow badge that lists exactly what would be allowed).

- **`orbit.http.fetch(url, { method, headers, body })`** (`electron/lib/fragments/fragment-http*.ts`). The manifest carries `hosts` (bare public DNS names, set by `fragment_set_http`). A request must be https on 443 without URL credentials, to a declared host — re-checked on every redirect hop (max 3). The page's CSP stays closed: the request is made by Node's https client in the main process, never Chromium, so no cookies or stored logins exist to forward; `Cookie`, `Authorization`, `Host`, `Origin`, `Sec-*`… are refused as request headers and `Set-Cookie` is dropped from the response. The resolved address is checked at connect time (loopback / private / link-local / CGNAT blocked), so DNS tricks cannot reach the local network. Caps: 2 MB response (cut and flagged `truncated`), 256 KB request body, 20 s total, 30 calls/min and 4 in flight per fragment.
- **`orbit.mcp.list()` / `orbit.mcp.call(server, tool, args)`** (`fragment-mcp.ts`, plus `listMcpServerToolNames` / `callMcpToolByName` in `lib/mcp/index.ts`). The manifest carries `mcp: [{ server, tools }]` (`fragment_set_mcp`). Only declared pairs on servers the person has connected and enabled; the app's own MCP clients do the call. Result flattened to text (images/audio dropped), capped at 60k chars, 60 s, 20 calls/min, 2 in flight. Errors surface as `mcp_unavailable`, `tool_not_allowed`, `mcp_tool_error` (tool's own text) or `mcp_failed`.
- **Grants follow the declaration.** Widening `hosts` or `mcp` after the person allowed it drops that grant (narrowing keeps it), so an agent cannot enlarge scope behind an old approval. Grant is still one capability per kind, not per host/tool.
- **Budgets** now share one helper (`fragment-budget.ts`), `orbit.ai` included.
- **Agent tools** (`tools/fragment.ts`): `fragment_set_http`, `fragment_set_mcp`, `fragment_open`, `fragment_read_data` (read-only, 30k chars), and `fragment_list` now shows asked/allowed. Create, list, open and read-data are all in the normal toolset (family `fragments`); there is no tool that grants or reads other fragments' code. Orbit exposes no MCP *server* to external clients today, so nothing was added on that side.

Open product decisions: per-host / per-tool consent instead of one switch per capability; whether to allow an `Authorization` header (blocked now, so keyed APIs only work with a key in the URL); whether to build an external MCP server surface (it would need its own auth and a way to hold the same locks as the in-app agent); whether `create` should accept a plain description and generate the page itself (today the agent writes the HTML with `fragment_create`).
