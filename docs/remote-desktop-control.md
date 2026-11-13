# Remote desktop control

**Status:** plan, not implemented.
**Supersedes:** the read-only model described in `multi-desktop-peers.md`.
**Premise:** connecting to another Orbit is remote access, not a viewer. The data stays on the machine that owns it and the paired client controls it — exactly the model the mobile app already uses.

---

## 1. Where we are

### The four layers

| Layer | Today | Where |
|---|---|---|
| Protocol | Full companion surface: sessions, folders, messages, memory, routines, pipeline, plan review, orchestration, queue, models, git, skills, MCP, preferences — plus HTTP (media list/usage/delete, skills, git, voice) | `packages/shared/src/companion.ts`, `apps/desktop/electron/lib/companion-http.ts` |
| Server | The companion server answers all of it | `apps/desktop/electron/lib/companion-server.ts` |
| Reference client | The mobile uses `@orbit/companion-client` (WS + HTTP) and has full control | `packages/companion-client`, `apps/mobile` |
| Desktop peer | A hand-written mini-client (~13 requests), a reduced HTTP server (only `/peer/file`) and read-only screens | `apps/desktop/electron/lib/peers/*` |

The desktop path is not a smaller copy of the mobile path by accident: it was designed that way.

`apps/desktop/electron/lib/peers/permissions.ts` opens with:

> "The phone keeps the full companion API (it is the owner's own device, paired by scanning a QR on this screen). A desktop is someone else's machine on the same network, so it gets an allowlist."

That decision is the limitation. The server that answers the phone is the same one that answers the desktop (`attachDesktopClient`, `companion-server.ts`).

### What blocks full control

1. **Policy.** The allowlist in `peers/permissions.ts`, enforced per request in `companion-server.ts` (`handleRequest` → `desktopMayRequest`).
2. **Server HTTP.** `peers/peer-server.ts` (`handleHttp`) only matches `/peer/file/<scope>/<id>`. None of the companion HTTP API is reachable by a desktop.
3. **Client.** `peers/peer-client.ts` implements a fixed set of requests, drops archived sessions from the list and ignores `folders` events.
4. **Shared client.** `CompanionHttp` hardcodes `http://host:port+1`; `CompanionWebSocket` hardcodes `ws://host:port` and the PIN `auth` handshake. Neither can talk to the peer's TLS server as-is.
5. **Renderer.** Separate `RemoteSessionList` and `RemoteChatView`; the media gallery always reads local data, even inside a remote chat.
6. **Persistence.** The active environment is in-memory and resets on reload.

### What already works in our favor

- **Same envelope.** `peer-client.ts` already speaks `{ id, payload }` and handles `api:response` — the exact wire format of `CompanionWebSocket`.
- **Same attach path.** `peer-server.ts` validates the device token and calls `attachDesktopClient`, which turns the socket into a full companion client.
- **HTTP handlers exist.** Media list/usage/delete, skills, MCP, git, voice and preferences are implemented in `companion-http.ts`; only the peer server does not mount them.
- **Assets work.** `/peer/file/<scope>/<id>` already serves media, pieces, documents and artifacts with Range/ETag.
- **Pieces route by prefix.** Motion, design, slides, documents and artifacts already flow through the peers IPC.
- **Security primitives.** Pairing with a comparison code, pinned certificates, mutual TLS, device tokens, revoke and reconnect already exist.

---

## 2. Target architecture

```
renderer (same components: ChatHistory, ChatView, MediaGallery, panel)
   │
   └── EnvSource  (local | peer)  ← capabilities decide what is enabled
          │
          ├── local  → existing IPC → SQLite / orbit-data
          │
          └── peer   → peers:request / peers:http → main process
                                                   │
                                                   ├── CompanionWebSocket (mTLS, pinned)
                                                   └── CompanionHttp     (mTLS, pinned)
                                                          │
                                                          └── peer server
                                                              ├── /api/*      (same router)
                                                              ├── /peer/file  (unchanged)
                                                              └── WS: attachDesktopClient
```

Rules:

1. **One protocol, one server implementation, one client package.** The desktop peer is another client, not another API.
2. **The environment is the data source.** Components do not branch on "remote"; they receive a source and its capabilities.
3. **No local data leaks into a remote environment.** Today the gallery does exactly that.
4. **The host decides what it grants, and the pairing screen says it plainly.**

---

## 3. Decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | What a paired desktop gets | **Full control by default**, with "view only" as an explicit choice at pairing. Optional per-host setting "confirm destructive actions on this computer" (default off). |
| D2 | How the desktop talks to the peer | Reuse `@orbit/companion-client`, not a bespoke client. |
| D3 | Session ids | Keep namespacing (`peer:<peerId>:<id>`). It is what keeps local and remote from colliding. |
| D4 | Media | Follows the active environment. The remote gallery reads the peer's registry, not the local one. |
| D5 | Terminal, computer use, provider keys | Out of scope. They are not in the companion protocol, and exposing them is a different risk class. |
| D6 | Remote editing of pieces | Out of scope for v1. Pieces open read-only; editing stays on the machine that owns the files. |

Open question (only one): D1's confirmation setting — default off makes it identical to the mobile; default on is safer for destructive actions. The plan assumes **off**, with the setting available in Phase 6.

---

## 4. Work plan

Sizes are relative: **S** ≤ 1 day, **M** 2–3 days, **L** 4–8 days, **XL** > 8 days.

### Phase 0 — Contract and policy (S)

**Goal:** a paired desktop is a trusted client; the allowlist becomes a capability set.

Changes:

- `packages/shared/src/peers.ts`
  - Add `control?: boolean` to `PeerGrants` (and to `normalizeGrants`).
  - Add `EnvCapabilities` to `PeerSnapshot`: `{ control, send, files, view }` so the renderer never infers from `grants`.
- `apps/desktop/electron/lib/peers/permissions.ts`
  - Replace `desktopMayRequest(type, grants)` with `desktopCapabilities(grants)`.
  - Keep `isDesktopOnlyRequest` (pieces/design/slides/documents/artifacts) untouched.
  - With `control`, every non-desktop-only request is allowed; with `view` only, keep today's list.
- `apps/desktop/electron/lib/companion-server.ts`
  - `handleRequest`: the `client.kind === 'desktop'` block keeps `isDesktopOnlyRequest` and `sanitizeDesktopSend`; the allowlist check becomes a capability check.
- i18n (`pt-BR`/`en`): pairing copy states "controle total: chats, mídias, peças, memória, rotinas e aprovações desta máquina" vs "somente visualização".

Acceptance:

- A paired desktop with `control` can call `folders:list`, `sessions:rename`, `memory:list`, `plan:review-decision`.
- A `view`-only peer still gets `forbidden` for the same calls.
- Unit test for the capability matrix.

### Phase 1 — Server parity: mount the HTTP API (M)

**Goal:** the peer server exposes the same REST surface the phone uses.

Changes:

- `apps/desktop/electron/lib/companion-http.ts`
  - Export the router (`createRouter` → `createCompanionRouter`), or add `createPeerRouter`.
  - Fix `mediaUrlFor` and `fileUrlFor`: the base is hardcoded `http://${req.headers.host}`; derive the scheme from `req.socket.encrypted` so the peer server returns `https://host:3849/...`.
- `apps/desktop/electron/lib/peers/peer-server.ts`
  - `handleHttp`: after `validateDesktopToken`, route `/api/*` to the companion router; keep `/peer/file/*` as-is.
  - The router is mounted **behind** the peer's own authentication: pass a `validateToken` that is a no-op (the token was already validated in `handleHttp`) and never expose that router on the companion port.
  - PIN endpoints are not reachable on the peer server (pairing has its own flow).
  - `DELETE /api/media/*` requires `control`; `view` gets 403.
- Events: `broadcastSessionEvent` already reaches every attached client. Confirm `folders`, `prefs`, `queue` and `media` events are forwarded; add a `media:changed` event if it does not exist.

Acceptance:

- `curl --cert client.pem --key client.key -H "Authorization: Bearer <token>" https://host:3849/api/media` returns entries with `https://host:3849/api/file/...` URLs.
- `GET /api/media/usage` and `DELETE /api/media/<id>` work.
- The phone path (ports 3847/3848) is unchanged.

Risk: the asset token is signed for the same secret, so `/api/file/...?<token>` works on both servers. Verify `serveAsset` does not depend on the port.

### Phase 2 — Client parity: use `@orbit/companion-client` (M)

**Goal:** delete the hand-written request map; the desktop uses the package the phone uses.

Changes:

- `packages/companion-client/src/types.ts`
  - `ConnectionConfig`: add `wsUrl?`, `httpUrl?`, `fetch?`, `createWebSocket?`, `tls?`, `handshake?`.
- `packages/companion-client/src/http-client.ts`
  - `baseUrl = config.httpUrl ?? 'http://host:port+1'`.
  - `request()` uses `this.fetchImpl ?? fetch`.
- `packages/companion-client/src/websocket-client.ts`
  - `open()` uses `config.wsUrl ?? 'ws://host:port'` and `config.createWebSocket ?? ((url) => new WebSocket(url))`.
  - Add a `handshake` hook: default sends `auth` with the PIN; the desktop passes a function that sends `peer:auth` and accepts `peer:auth-ok`. Everything after the handshake is identical — `peer-client.ts` already uses the same `{ id, payload }` / `api:response` envelope.
- `apps/desktop/electron/lib/peers/peer-client.ts`
  - Per peer: one `CompanionWebSocket` with `ws` (TLS options from `tls-options.ts`) + one `CompanionHttp` with an `https.request`-based fetch (`ca` = peer cert PEM, client cert/key = identity).
  - Remove `PeerConnection.request()` and its `pending` map; keep pairing, storage, snapshots, `remote-index`, and the `PeersEvent` emitter.
- Reconnect, heartbeat and request queue come from the package (already more robust than the current one).

Acceptance:

- Today's features still work after the swap (messages, send, pieces, files).
- `CompanionWebSocket` reconnects automatically after the peer restarts.

Risk: the package is DOM-typed (`WebSocket`, `fetch`). The `ws` instance needs a thin adapter for `onopen/onmessage/onclose/onerror` — isolate it in `peers/ws-adapter.ts`.

### Phase 3 — Generic IPC bridge (S/M)

**Goal:** the renderer can call any companion request without a new IPC channel per feature.

Changes:

- `apps/desktop/electron/preload.ts` + `src/lib/ipc.ts`
  - `peersApi.request(peerId, req)` → WS.
  - `peersApi.http(peerId, method, path, body)` → HTTP.
  - `peersApi.onEvent` already exists; forward all events for the **active** env, keep a light session-list update for the others (throttled).
- `apps/desktop/electron/lib/peers/index.ts`
  - Validate `peerId` against known peers and the request type against `desktopCapabilities` — never trust the renderer.
  - Reject when offline with a typed error.

Acceptance:

- From the renderer: `peersApi.request(peerId, { type: 'folders:list' })`.
- A `view`-only peer gets `forbidden`.
- Event flood is bounded (measure: one peer streaming a long answer).

### Phase 4 — Renderer: environment as source (XL)

This is the bulk. Five sub-phases, each shippable on its own.

#### 4.1 `EnvScope` (S)

- `src/lib/env.tsx`: `{ id, kind, name, online, capabilities, peerId? }`.
- `src/hooks/use-env.ts` for reads.
- `peers-store` derives it from `snapshot` + `env`; persist the chosen env (`orbit.env`) and restore on boot.
- Components stop reading `usePeersStore(s => s.env)` directly.

#### 4.2 Sessions and folders (L)

- `src/lib/session-source.ts`:
  ```ts
  interface SessionSource {
    list(): Promise<SessionInfo[]>
    folders(): Promise<FolderInfo[]>
    create(input: NewSessionInput): Promise<SessionInfo>
    rename(id: string, title: string): Promise<void>
    setPinned(id: string, pinned: boolean): Promise<void>
    setArchived(id: string, archived: boolean): Promise<void>
    remove(id: string): Promise<void>
    move(id: string, folderId: string | null): Promise<void>
    search(query: string): Promise<SessionInfo[]>
  }
  ```
- `LocalSessionSource` wraps the existing store/IPC; `PeerSessionSource` wraps `peersApi.request`.
- Refactor `ChatHistory` (`app-sidebar.tsx`) to receive the source through `EnvScope`, keeping the exact same rows, folders, menus, search and empty states.
- Delete `RemoteSessionList` and the `env !== "local"` branch around the sidebar list.
- Peer client: stop filtering archived sessions; request and follow `folders`.

Acceptance: the sidebar looks and behaves the same in both environments — create, rename, pin, archive, delete, move to folder, search.

#### 4.3 Media (L)

- `MediaGallery` receives the source; peer mode uses `peersApi.http('/api/media')` and `/api/media/usage`.
- Render remote entries with the `url` the server already signs; local entries keep `orbit-media://`.
- Scopes: `session` maps to the active remote session; `project` uses the peer's sessions; `backfill` is local-only and hidden remotely.
- Delete and "delete many" route to the peer, with confirmation.
- Refresh on `media:changed` (or on panel open, as a fallback).
- No id registry needed: the HTTP entries carry absolute signed URLs.

Acceptance: with `env = another machine`, the gallery shows that machine's images, videos, pieces and documents; opens each one; deletes with confirmation; never shows local files.

#### 4.4 Chat (XL)

- Extract the message renderer from `ChatView` so `RemoteChatView` can reuse it (parts, tool calls, diffs, plan cards).
- Composer driven by capabilities: send/abort; text-only in v1 (remote attachments need an upload path — see Non-goals).
- Approvals: `session:state` + ask events, same cards, reply through `ask:reply` / `plan:review-*`.
- Once parity is reached, `ChatView` takes the source and `RemoteChatView` is deleted.

Acceptance: a chat opened remotely sends, streams, aborts, answers asks and approves plans; model/mode/tools controls reflect the host.

#### 4.5 Panel (M)

- Verify piece/design/slides/document/artifact already open through the peer.
- Media tab uses 4.3.
- Editing a remote piece is disabled with a clear affordance (D6).

### Phase 5 — Footer, status and affordances (S)

**Goal:** the environment control lives where the connect button is, and the person always knows where they are.

Changes (`app-sidebar.tsx`, `environment-selector.tsx`, `peers-store.ts`):

- No peer paired: the current full-width "Conectar dispositivos" button.
- At least one peer: a compact environment select in the footer (Este computador, each machine with an online dot, separator, "Conectar dispositivo…", "Gerenciar dispositivos") and, next to it, an icon-only button with the phone icon that opens the modal on the phone tab.
- Remove the selector from the sidebar header.
- Persistent indicator while a remote env is active: "Controlando <nome>" + disconnect, in the main header.
- Offline env: cached list + banner, actions disabled.
- Remember the last session per peer.

Acceptance: switching machines takes one click; reloading keeps the env; it is always visible which machine is being controlled.

### Phase 6 — Safety and audit (M)

- Pairing screen lists exactly what is granted; "view only" is a real choice.
- Host devices list distinguishes phone vs desktop and can revoke (`revokeDevice` already exists).
- `peers/audit.ts`: ring buffer (last 200) of remote actions that change state — create/delete session, delete media, approve plan, merge/deliver, run routine. Persisted under `peers/audit`; exposed in the devices modal.
- Optional confirmation gate (`control` + setting on): destructive requests emit `peers:confirm` to the local renderer and wait for `peers:confirm-reply`; timeout denies. HTTP deletes go through a pre-handler that honors the same setting.
- Rate-limit state-changing requests per device (reuse the auth failure limiter pattern).

Acceptance: every destructive remote action is auditable; revoke works mid-session; with the setting on, nothing destructive executes without a local click.

### Phase 7 — Tests and rollout (M)

- Unit: capability matrix; router mounted on the peer server (URLs use `https`); event fan-out.
- Integration harness: two profiles on `127.0.0.1` with separate `userData` dirs, scripted pairing using a test PIN, then the scenario matrix below.
- Feature flag for the first release (`ORBIT_PEERS_FULL_CONTROL=1`), default off for one build, then on.

Scenario matrix (both directions):

| Scenario | Expected |
|---|---|
| Create/rename/pin/archive/delete a remote chat | Mirrors on the host, folders included |
| Send a message, abort mid-stream | Same behavior as local |
| Approve a plan / answer an ask | Executes on the host |
| Media list, open image/video/piece/document | Same content as the host gallery |
| Delete a media item | Removed on the host, with confirmation |
| Host goes offline mid-action | Typed error, banner, reconnect |
| Revoke the device on the host | Socket closes, env shows revoked |
| View-only peer | Every write returns forbidden |
| Two clients approving at once | Second gets a stale error |

---

## 5. Non-goals

- Terminal, computer use and shell access over the peer.
- Provider keys and local settings of the host.
- Writing files on the peer (`fs:*` stays read-only, behind its own grant).
- Editing pieces remotely (v1).
- Mixing local and remote data in the same list.
- Remote attachments in the composer: the desktop has no upload endpoint yet. The phone attaches through `messages:send` with data it already holds; a desktop file would need `POST /api/upload` (host copies it into the media registry and returns the id). Plan for a later phase.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `CompanionHttp`/`CompanionWebSocket` are browser-typed | Inject `fetch` and a `ws` adapter; keep the package's API unchanged |
| `mediaUrlFor`/`fileUrlFor` hardcode `http://` | Derive the scheme from `req.socket.encrypted` in Phase 1 |
| Event volume with a streaming peer | Forward all events only for the active env; throttle the rest |
| Renderer stores assume local state | `EnvScope` + source interface; never read local stores in peer mode |
| Double approvals from two machines | Server rejects stale decisions (verify; add a request id check) |
| Full control is destructive | Audit log, visible indicator, revoke, optional local confirmation |
| Version skew between builds | Keep `PEER_PROTOCOL_VERSION`; refuse a peer with a different major |
| TLS fetch fragility | Pin the CA and the client cert from the stored peer identity; fail closed, never fall back to plain HTTP |

---

## 7. End state

- [ ] A paired desktop can do everything the mobile app can do, and nothing extra.
- [ ] The sidebar, chat, media gallery and panel look the same in every environment.
- [ ] The footer carries the environment select and the phone button.
- [ ] The active machine is always visible, with a one-click disconnect.
- [ ] Nothing from the local machine appears inside a remote environment.
- [ ] Destructive remote actions are auditable and revocable.

---

## 8. Order and size

| Phase | Size | Depends on |
|---|---|---|
| 0 — Contract and policy | S | — |
| 1 — Server parity (HTTP) | M | 0 |
| 2 — Client parity (`companion-client`) | M | 0 |
| 3 — Generic IPC bridge | S/M | 2 |
| 4.1 — `EnvScope` | S | 0 |
| 4.2 — Sessions and folders | L | 1, 3 |
| 4.3 — Media | L | 1, 3 |
| 4.4 — Chat | XL | 2, 3 |
| 4.5 — Panel | M | 4.3 |
| 5 — Footer and status | S | 4.1 |
| 6 — Safety and audit | M | 1 |
| 7 — Tests and rollout | M | all |

Phases 0–3 can ship without a visible change; the experience changes from 4.2 onward. The footer (5) can be delivered early because it only depends on 4.1.
