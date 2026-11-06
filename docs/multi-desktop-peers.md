# Multiple desktops: Orbit talking to Orbit on the same network

Today the Orbit desktop only plays **server** (the phone connects to it). This plan lets one desktop also play **client** of another desktop: see its chats, follow the ones running in real time and send messages to them.

## Status

**Implemented (stages 0 to 5), not yet checked by hand in two real windows.** The network
part is covered by tests with real sockets (`electron/lib/peers/*.test.ts`, including an
end-to-end pairing between two "machines" in one process).

Where it landed:
- `packages/shared/src/peers.ts` — types, ids (`peer:<peerId>:<id>`), wire messages.
- `electron/lib/peers/identity.ts`, `tls-options.ts` — self-signed certificate per install
  (node-forge), mutual TLS 1.3, the peer's certificate pinned as the only CA.
- `pairing.ts` — the code from both certificates + both nonces, pending requests with limits.
- `permissions.ts` — the desktop allowlist; `desktop-requests.ts` — pieces, documents and files.
- `fs-access.ts` — read-only project files, realpath containment, secrets hidden.
- `peer-server.ts` (port 3849), `peer-client.ts`, `discovery.ts` (UDP beacon, port 3850),
  `remote-index.ts` + `remote-assets.ts` (orbit-* schemes fall back to the peer), `index.ts` (IPC).
- `companion-server.ts` — device kind/grants/fingerprint, desktop tokens refused on the phone
  server, revoke, raw orbit-* for desktops, phone-only broadcasts.
- Renderer: `src/stores/peers-store.ts`, `src/components/peers/*`, `components/connect-app-dialog.tsx`.

Differences from the text below:
- Discovery is a small UDP beacon instead of mDNS (no new dependency). Same opt-in rules.
- TLS came in from the start (it was stage 5), and the code mixes the certificates in.
- Beyond chats: images, attachments, audio, video, artifacts, documents, motion, design and
  slides of the other machine open here (read-only), through the pinned connection; the
  runtime of motion/design/slides is injected by THIS machine. Project files are a third
  grant ("see project files"), next to "send messages".
- `ask:reply`, plan reviews and orchestration approvals are never allowed for a desktop:
  approvals stay on the machine that runs the agent. A sent message keeps only the text.
- Dev only: `ORBIT_DEV_PROFILE` (another profile) and `ORBIT_PEER_PORT` (another port) to run
  two instances on one machine.
- Remote fonts (`orbit-font://`) are not proxied: a remote piece falls back to local fonts.

Decisions already taken:

- One "Connect devices" entry (replaces "Connect App") with two paths: **Phone** and **Another computer**.
- Discovery is **opt-in**: "Allow this computer to be found" starts off. Off means the machine is not advertised and refuses pairing requests.
- Pairing is **accepted on the receiving machine** by a card (toast + modal), with a short code shown on both screens. A manual code stays as a fallback for networks that block discovery.
- The environment selector shows up **only when at least one desktop is paired**, and a "Running on other desktops" strip sits at the top of the list.
- v1 is **chat only** on remote environments: no files, diff, terminal or git from the other machine.

---

## Current state

| Piece | Where | How it is today |
|---|---|---|
| WS server | `electron/lib/companion-server.ts` | Port 3847, `0.0.0.0`, started at boot (`main.ts`). Auth by PIN (6 digits, 5 min, 5 tries/min) or persistent device token. |
| HTTP API | `electron/lib/companion-http.ts` | Port 3848. `/api/ping` is public and exposes the PIN while "pairing mode" is on. CORS `*`. |
| Paired devices | `companion/devices` | `{ token, deviceName, pairedAt, lastSeenAt }`. No kind, no permission: every device can do everything. |
| Protocol | `packages/shared/src/companion.ts` | ~90 request types (`sessions:list`, `messages:send`, `ask:reply`, `fs:list-dirs`, `memory:*`, `prefs:set`...). |
| Live events | `forwardChatEvent` | Streams every `ChatEvent` to every authenticated client. |
| Client | `packages/companion-client` | `WebSocket` client built for the mobile. Uses the global `WebSocket`. |
| Discovery | `apps/mobile/src/hooks/useDesktopDiscovery.ts` | Probes only hosts from recent connections. No mDNS. |
| UI | `connectApp` i18n block + `companionApi` in `src/lib/ipc.ts` | Modal with QR and PIN. |
| Renderer state | `src/stores/session-store.ts` | `startChatMirror` applies `ChatEvent`s keyed by `sessionId`. |

What does **not** exist: a desktop-side client, mDNS, permissions per device, TLS, any notion of "environment".

---

## Design

### 1. Identity and permissions

Each install gets a stable `peerId` (random, stored once). The paired-device record grows:

```ts
interface PairedDevice {
  token: string
  deviceName: string
  kind: 'phone' | 'desktop'      // old records migrate as 'phone'
  peerId?: string                // desktop only
  perm: 'view' | 'send'          // phone keeps 'send' (behavior unchanged)
  pairedAt: number
  lastSeenAt: number
}
```

Enforcement lives in **one place**, at the top of `handleRequest` in `companion-server.ts`, as an **allowlist per permission** (deny by default for `kind: 'desktop'`):

- `view`: `sessions:list`, `sessions:running`, `session:state`, `messages:get`, `status:get`.
- `send` adds: `messages:send`, `chat:abort`, `ask:reply`, `plan:review-*`, `orchestration:*`, `queue:get`, `queue:op`.
- **Never** for a desktop, whatever the permission: `fs:list-dirs`, `memory:*`, `git:*`, `sessions:delete/archive/move-folder/revert*`, `folders:*`, `routines:*`, `pipeline:*`, `prefs:set`, `worker-config:set`, `models:select`, `analytics:*`.

The permission is **directional**: what B grants A says nothing about B seeing A.

A message sent from a peer runs under the **receiving machine's** permission mode and directories. The sender must see that in the UI ("runs on Ana-MBP").

### 2. Discovery (opt-in)

- New setting `peers/discoverable` (default `false`), toggle in the Connect devices modal.
- On: advertise `_orbit._tcp` via mDNS with TXT `{ peerId, name, wsPort, version }` (`bonjour-service`, pure JS, no native build).
- Off: stop advertising **and** reject `peer:request` with `not_discoverable`.
- Browsing (looking for others) only runs while the "Another computer" tab is open. Listening does not expose the machine.
- Fallback: manual address field. The receiving machine can also show a **manual code** (IP:port + 6 digits, valid 5 min) that skips the accept card. It is the existing PIN logic, accepted only with `perm: 'view'`.

### 3. Pairing by accept card

```
A (Notebook-Lia)                                  B (Ana-MBP)  [discoverable on]
  click "Connect"
  open WS, send peer:request {peerId, name, nonceA}
                                                  main: queue request, emit 'peer:incoming-request'
                                                  renderer: toast + modal card
                                                    name, IP, code, [View | View and send], Accept / Decline
  shows same code, "waiting for Ana-MBP..."
                                                  user accepts
  receives peer:accepted {token, perm, peerId, nonceB}
  stores token, shows B in the selector
```

- **Code** = first 6 digits of `SHA-256(nonceA || nonceB || certFingerprintA || certFingerprintB)` (the fingerprints come in stage 5; before that, nonces only). Both screens show it, people compare.
- The card is global (toast anywhere in the app), not only inside the modal. If the window is unfocused, an OS notification uses the existing `notification-prefs-store`.
- Limits: at most 3 pending requests, 1 request per IP per minute, auto-expire in 60 s, duplicate from the same `peerId` replaces the previous one.
- Declined and expired requests leave no record other than a short log line.

### 4. Desktop client in the main process

New folder `electron/lib/peers/`:

| File | Role |
|---|---|
| `peer-store.ts` | Paired peers: `peerId, name, host, port, token, perm, certFingerprint`. Token encrypted with Electron `safeStorage`. |
| `peer-client.ts` | One WS connection per peer. Auth with token, heartbeat, exponential-backoff reconnect, request/response by id. Reuses the framing of `packages/companion-client` (extract the transport so Node can use it without React Native imports). |
| `peer-discovery.ts` | mDNS advertise/browse. |
| `peer-pairing.ts` | Pending-request queue, code derivation, rate limits. Pure, tested. |
| `peer-permissions.ts` | The allowlists above. Pure, tested. |
| `peer-router.ts` | Maps a namespaced session id to `(peer, remote id)`. |

The peer client keeps a cache of `sessions:list` and `sessions:running` per peer, refreshed by events and by a 30 s resync after a reconnect.

### 5. Renderer: environment without rewriting the app

The least invasive path is **namespaced session ids**: a remote session is `peer:<peerId>:<sessionId>`.

- `chatApi` calls in main check the prefix. No prefix → local path as today. Prefix → `peer-router` forwards to the right `peer-client`.
- Remote `ChatEvent`s are re-emitted to the renderer with the id rewritten to the namespaced one, so `startChatMirror` / `applyChatEvent` keep working untouched.
- New `src/stores/env-store.ts`: `activeEnvId` (`local` | `peerId`), peers with `online`, `perm`, and the "running elsewhere" list.
- Remote sessions are **chat only**: panels that read the local disk (changes, file browser, terminal, git branch, computer/browser tabs) are hidden for namespaced ids, with a one-line notice. A guard helper `isRemoteSession(id)` is the single switch.
- Remote media already arrives with URLs rewritten to the host we used; `<Image>`/`<video>` need no change.

### 6. Interface

- **Environment selector**: rendered below the workspace selector in the sidebar, **only when ≥ 1 desktop is paired**. Lists "This computer" and each peer with a status dot. Last row: "Connect devices…". Picking a peer swaps the session list for that peer's and tints the top bar (accent) with `Remote environment: Ana-MBP · View and send`.
- **Running on other desktops**: strip at the top of the list, visible in **any** environment, one row per running chat (`chat title`, machine name, activity dot). Click switches environment and opens the chat. Rows also show `waiting for you` when the remote chat has a pending `ask` or plan review. Strip hides when empty.
- **Connect devices modal** (replaces "Connect App"): segmented `Phone | Another computer`. Phone = today's QR + PIN. Another computer = "Allow this computer to be found" toggle, list of desktops found, manual address field, then the paired list (both kinds) with Revoke.
- **Incoming request card**: toast + modal as in section 3.
- All strings in `en.json` and `pt-BR.json`.

### 7. Security

| Risk | Answer |
|---|---|
| Anyone on the LAN pairs | Opt-in discovery + explicit accept + matching code + rate limit + 60 s expiry. |
| Spoofed peer in the middle | Stage 5: TLS with a self-signed certificate, trust on first use, fingerprint mixed into the code. |
| Remote user runs things on my machine | `view` by default, `send` chosen per peer on the accept card, allowlist, no fs/git/memory/settings. The receiving machine's permission mode still applies. |
| Stolen token | Stored with `safeStorage`; Revoke in the modal drops the token and the open socket at once. |
| PIN leak through `/api/ping` | Never exposed for `kind: 'desktop'` pairing; the accept card replaces it. The phone path keeps today's behavior. |
| Token reuse after rename/IP change | Token is bound to `peerId`, not to the address. |

---

## Stages

Each stage ships and can be reverted on its own.

**0. Extract and prepare**
- Move the transport of `packages/companion-client` to something Node can import (no React Native). 
- Add `peerId`, `kind`, `perm` to `PairedDevice` with a migration (`phone` / `send`).
- Done when: the phone still pairs and works exactly as before; tests cover the migration.

**1. Permissions**
- `peer-permissions.ts` + enforcement at the top of `handleRequest`.
- Done when: a `desktop`/`view` token gets `forbidden` for every request outside the allowlist; unit tests list every request type and its class (a new request type without a class fails the test).

**2. Pairing without discovery**
- `peer-pairing.ts`, `peer:request` / `peer:accepted` / `peer:declined`, incoming-request card (toast + modal), connect by manual address, `peers/discoverable` setting (gates `peer:request`).
- Done when: two instances (different ports through an env override) pair by address with the card; decline and expiry behave; rate limit tested.

**3. Client and read-only environment**
- `peer-store`, `peer-client`, `peer-router`; namespaced ids; `env-store`; environment selector; remote chat view in read-only; "Running on other desktops" strip.
- Done when: a running chat on B streams live on A, the strip updates and survives a B restart (reconnect), and no panel tries to read B's disk from A.

**4. Sending**
- `send` permission on the accept card; input enabled for remote chats with `send`; busy → queued notice; "runs on X" label; abort and `ask:reply` / plan review from A.
- Done when: A sends to a B chat, B's UI shows the incoming message as remote, and `session_busy` is handled.

**5. Discovery and hardening**
- mDNS advertise/browse behind the toggle; TLS with TOFU and fingerprint in the code; Revoke closes sockets; OS notification when the window is unfocused.
- Done when: devices appear without typing an address on a normal Wi-Fi; toggling off makes the machine vanish and refuse requests; a changed certificate blocks the connection with a clear message.

**6. Agent to agent (optional, later)**
- Tool `peer_send` in `electron/lib/tools/` so an agent can message a chat on another desktop, behind a permission prompt.

## Tests

Pure modules get vitest suites like the rest of the codebase: `peer-permissions` (every request type classified), `peer-pairing` (code derivation, limits, expiry, replacement), `peer-router` (prefix parsing, local passthrough), device migration. Manual run for stage 2+: two instances on one machine with different ports, then two real machines on one Wi-Fi.

## Risks and open points

- **Two instances on one machine** need configurable ports and storage dir for testing (today 3847/3848 are fixed). Needed from stage 2.
- **Corporate Wi-Fi** with client isolation or no multicast: manual address/code is the only path. Out of scope: relay across networks (Fragments Plus).
- **Remote sessions and local features** (search, folders, archive, drag): v1 hides what does not apply; the guard helper `isRemoteSession` has to be applied everywhere the sidebar and chat header touch the disk.
- **Time zone / clock skew** does not matter (no signed timestamps), but the code window is 60 s, so a very wrong clock on one side should not break it.
- **Protocol version**: add `protocolVersion` to the `peer:request`; refuse with a clear message on mismatch.
