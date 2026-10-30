# Computer Use (controlling the computer)

The Orbit agent sees and operates other Mac apps: it reads the screen (screenshot)
and the accessibility tree of the target app and acts on it (click, typing, keys,
scroll, drag). All in TypeScript inside `electron/lib`, with no compiled binary,
native addon or external MCP. The only piece outside TS is the JXA bridge,
a script that macOS itself runs.

v1 is **macOS only** and stays **off in the Mac App Store**, because the store's
sandbox blocks accessibility and event injection. Windows and Linux will have their own
plans (see "Outside v1").

## How to turn it on

There are two switches, and both need to be on:

1. **Preferences → Computer → Control the computer** (comes turned off).
2. **Computer mode** in the conversation: in the composer's "+" menu, in chat or code.
   Every chat starts with the mode off and there is no global default. The mode
   does not go to the phone either: it stays out of `session-modes-sync.ts`.

In the mode bar below the composer, Computer stays **hidden by default**.
Whoever wants the shortcut in the bar turns it on in Preferences → Appearance → visible
modes.

With only one of the switches on, the `cu_*` tools do not exist in the turn. If the
mode is on and the switch is not, the prompt explains to the agent how to turn it on.

## Architecture

```
electron/lib/computer/
  bridges/macos.js   JXA bridge (osascript -l JavaScript): one invocation = one operation
  runner.ts          spawn + timeout + abort + parse; an error always becomes ComputerError
  drivers/macos.ts   driver: bridge, screencapture and "open"
  types.ts           AppInfo, WindowInfo, AxNode, TreeSnapshot, BridgeAction, ComputerDriver
  geometry.ts        screenshot px ↔ global points
  keys.ts            "cmd+s" → virtual code + flags
  safety.ts          denylist, refusing Orbit itself, approval key per app/site
  registry.ts        numbered observations per session, path+identity handles, 120 s TTL
  format.ts          tree → indented text with an index (the contract with the model)
  observe.ts         observe (screenshot + tree) and query (search without a screenshot)
  act.ts             the cu_computer actions
  session.ts         active control: top banner, panic shortcut, returning the flags
  index.ts           façade: availability, status, test, dispose
electron/lib/tools/computer.ts   the 5 tools (zod + toModelOutput with an image)
```

**Bridge protocol.** The input JSON goes in `argv[0]` (`{ op, args }`) and the
response comes out on stdout: `{ ok: true, result }` or
`{ ok: false, error: { code, message } }`. The operations are `perms`, `apps`,
`tree`, `element` (info/press/focus/setValue), `mouse`, `drag`, `scroll`, `keys`,
`focused`, `activate` and `restore`. The bridge is imported with `?raw` and written
once into `$TMPDIR/orbit-computer/macos-bridge-<hash>.js`. The probe and the smoke read the
same file, so the measured code is the same one that runs in the app.

**Element handle.** The `AXUIElementRef` does not survive across processes. That is why
every index shown to the model keeps the path (`AXChildren` indices starting at
the window) and the identity (role and title). When acting, the bridge
re-walks the path and checks the identity. If they diverge, it becomes the
`staleIndex` error, never a click in the wrong place. A new observation of the same app
invalidates the previous one, and every observation expires in 120 s.

**Tree.** The tree is read with BFS and a budget (nodes, depth, children per
node and deadline), one `AXUIElementCopyMultipleAttributeValues` call per node, and
displayed in DFS. Empty groups get no line. Each element's frame is
shown **in the screenshot's space** (`@x,y wxh`), the same one as the `x`/`y`
coordinates. A secure field (`AXSecureTextField`) never has its value read.

**One coordinate space per window.** x/y and the tree's frames
(`@x,y wxh`) are always in the pixels of that window's screenshot, that is,
points × monitor scale, reduced to the longest side (`windowSpace`), **with or
without an image in the observation**. Before, without a screenshot, they became window points.
In the test in the app, the agent repeated "the same steps" from an observation with
an image in one without an image: it kept the "+15" offset (which was 7.5 pt) as
15 pt, and the drag fell **below the text line**, selecting nothing. In
TextEdit, the drag selects the line at +4/+8/+10 pt from the top and nothing at
+13/+15/+20 pt. The explanation the agent gave ("releasing 2 px outside the field
cancels the selection") did not hold up: measured, the selection stays.

**`select_text`.** Selects an excerpt of a text field **through AX**
(`AXSelectedTextRange`), with no coordinate and no mouse. It works with the app in
the background, and the following `type` replaces the selection. It finds the requested
text (with `occurrence` for repetitions) or selects everything. JXA does not build the
`CFRange` on its own: the bytes go in an `NSData` for the `AXValueCreate`, and the value
comes back wrapped with `castRefToObject`. Without the wrapper, the set answers OK and
selects nothing. Measured in TextEdit behind Claude: the 2nd occurrence of
"beta", the whole text, a clear error for nonexistent text, and "select range
+ type" replaced only the word.

**In the chat.** Each `cu_*` action appears with the sentence of what was done ("Click
element 12 · TextEdit") and, below it, what happened (the summary of
`cu_computer`, the app line in `cu_observe`, the results of `cu_query`).
A click shows the full output.

**Return of the selection.** After dragging or a double/triple click, the
result says what ended up selected (`op: 'selection'`, `AXSelectedTextRange`
+ `AXSelectedText`), or warns that nothing was and why. `triple_click` selects the
line (global pointer only).

**Geometry.** On macOS, AX, CGWindowList and events use global points, with the
origin at the top left of the main monitor and negative coordinates for
monitors to the left or above. Between the screenshot and those points there is only the
window's scale ratio. The DIP↔px conversion (`screen.dipToScreenPoint`) is from
Windows and is not used here.

## Tools

| Tool | Role | Gate |
|---|---|---|
| `cu_apps` | Visible apps and windows (pid, bundle, id, title, size) | Native (does not ask) |
| `cu_observe` | Screenshot and numbered tree of a window | Native |
| `cu_query` | Search in the tree by text/role, without a screenshot | Native |
| `cu_permissions` | Permission status; `request: true` asks the user | Native |
| `cu_computer` | Actions: left/right/middle/double/triple_click, move, drag, scroll, type, key, set_value, select_text, invoke, open_app, wait | Approval per app |

`cu_computer` tries the accessibility action first (AXPress, AXValue). On the
**directed** pointer (the default) everything goes through accessibility, because AppKit
ignores mouse and wheel events delivered by pid (Stage 0). The click by x/y becomes an AX
hit-test, scrolling moves the AX scroll bar, and keyboard and text go by pid.
Nothing moves the user's cursor, and the app can stay in the background. Double
click, middle click, hover and drag require the **global** pointer, which uses real
HID events. With `read_back` (the default), the response already brings the next
observation. If the tree does not change, the response warns that the action may
not have worked.

## Security

- **Denylist, hard block** in any permission mode: password vaults
  (1Password, Bitwarden, LastPass, Dashlane, Keychain, Passwords), System
  Settings and security prompts. It applies to observing too. It is checked at the gate
  (`isForbidden`, by the text) and again in the tool (after resolving the app).
- **Orbit itself** is never a target.
- **Password field**: the agent refuses `type` and `set_value`, whether on the indicated
  element or on the app's focus.
- **Approval per app.** The first action in each app asks for approval
  (`cu:app:<bundleId>`). In browsers the approval is per site
  (`cu:app:<bundleId>@<host>`, with the URL of the last observation). The options are
  the same as any Orbit permission:
  - **Allow in this turn:** the same rule does not ask again until the turn
    ends. That applies to every permission, not only Computer Use. Before it was "only
    this time", and the agent asked for the same thing on every click;
  - **Always in this chat:** applies to the conversation;
  - **Always:** saves that app's (or site's) rule, which applies from then on.

  Actions that always ask (like removing a worktree) stay one by one. The
  Unrestricted mode approves on its own, like `bash`.
- **Prompt injection.** Every text coming from the screen goes inside
  `<screen_content untrusted="true">`, and the prompt says that this is data and never
  an instruction. An action the screen asks for and the user did not ask for: stop and ask.
- **Visibility and stopping.** While the agent is in control, the yellow banner
  appears at the top of the screen, with the **Stop** button (a non-activating panel, without
  focus, the size of the banner: clicking does not bring Orbit to the front), and the
  "Controlling <app>" chip in the header, with **Stop**. The global shortcut
  **⌘⇧.** (or ⌘⇧Esc) stops everything. The shortcuts, the banner and the panels last the
  whole turn: with the old 20 s expiry without action, the agent thinking
  between two actions lost the shortcut, and ⌘⇧. did not stop anything. Stopping aborts the turn, which kills the
  bridge in progress and clears the conversation's approvals. The end of the turn or 20 s without activity end
  the control, release the shortcut and restore the accessibility flags turned on in the
  apps.

## With Orbit out of focus

While the agent controls another app and no Orbit window has focus, a
transparent window over the screen shows two panels in the design of the browser's
fullscreen (a collapsed handle that opens on hover):

- **left: the conversation**, live, with the approval cards. A new request
  opens the panel on its own, otherwise the agent would be waiting for a card nobody sees;
- **right: the `cu_*` actions** of this conversation, from the most recent to the
  oldest, each with the sentence of what it did, the output summary (a click expands) and
  the Stop button. At the top, the **thumbnail of the last screenshot** of the window
  being controlled, with the target of the last action marked (a rectangle on the element, a circle
  on the point). It shows *where* the agent acted even with the app behind other
  windows, because the screenshot is of the window, not of the screen.

**Screenshots outside the gallery.** With one observation per action (`read_back`),
saving every screenshot in the gallery would fill the media tab with dozens of
files per task. The model receives the image through `toModelOutput`, and main
keeps only the last screenshot of each conversation, in memory (`computer/shots.ts`),
deleted when the control ends.

**Cursor on the global pointer.** In global mode, the real cursor slides to the target
on a smoothed curve (~250 ms) before clicking, scrolling or dragging, instead of
jumping. In directed mode there is no cursor at all, not even drawn: the app is usually
in the background or covered, and a cursor painted over the screen would point at
the front window. It is the thumbnail with the marker that shows the place. (OCU
draws a software cursor over the app; it only makes sense with the target window
visible.)

Pieces: `computer/panels.ts` (the window: screen work area, `focusable: false`,
pass-through to the mouse outside the panels, `floating` level, below the yellow
banner), `computer-panels.html` + `src/computer-panels-main.tsx` (the
renderer's own entry, without the main window's synchronizers) and
`src/components/computer-panels.tsx`. The window mirrors the chat through
`startChatMirror()` in the sessions store: it applies the events to the state and skips the
side effects (disk, preferences and, above all, the message queue,
which the main window already fires).

## Recording a window

`cu_record_start` → actions with `cu_computer` → `cu_record_stop` records **one
window** and delivers an MP4 in the chat (and in the gallery).

- **Capture:** it is Electron's own. `desktopCapturer` finds the window by
  CGWindowID, and a hidden window records with `MediaRecorder` (H.264). Underneath
  it is ScreenCaptureKit: the window comes out whole **even covered by others**
  (measured). The recorder's page is a file, because `data:` is not a secure
  context and has no `mediaDevices`. The raw data goes to disk every second.
- **No idle time:** the recording runs straight and is **cut afterwards**
  (`recording-plan.ts`). Each action gets 0.3 s before and 0.9 s after, segments
  less than 0.5 s apart are joined, and `wait` stays whole (it is the agent holding a
  state on purpose). Cutting afterwards, instead of pausing the recorder, does not
  depend on the pause/resume latency.
- **Click pulse:** a yellow rectangle on the target of each action, at the instant of
  it (`drawbox`). In directed mode, with no cursor on the screen, it is what shows
  what was clicked.
- **The agent knows the timing:** `cu_record_stop` returns the timeline of the
  **final video** ("0.3–0.5s left_click on element 3"), to refine with
  `video_render` (EDL) if needed. `cu_record_mark` places marks.
- **Nothing is lost:** if the turn ends, or if the person clicks Stop or presses ⌘⇧.
  without `cu_record_stop`, the video is assembled anyway and goes to the gallery.
  Limit of 20 min per recording.
- **Measured on 2026-10-23:** 9.8 s recorded with 6 s of idleness became
  **2.7 s** of video, with 7.1 s cut. The assembly took 0.3 s, and the final file
  has 22 KB. While recording, macOS shows the "window being shared" icon in the title
  bar, and it shows up in the video.
- For web pages, `browser_record` (declarative script) remains better.

## Speed, subagent and batch

- **Read_back in text.** After each action, `cu_computer` returns the tree
  as text. The screenshot only enters the context with `screenshot: true` or when the
  tree is almost empty. The capture keeps happening, because it is what
  updates the thumbnail. In the real test (Chrome, ~30 actions in 12 min), the cost
  grew at every step, because the history resent all the screenshots.
- **`cu_batch`.** Up to 15 actions in one app in a single call, in order, stopping at
  the first error (which is told by its number) and with one observation at the end. It serves for
  predictable sequences, like clicking the address, typing and pressing Enter.
- **`computer_task` (subagent).** The main agent sends an objective and a dedicated
  agent runs the loop with a **short context** (only the objective and its own
  observations, never the conversation), using the model from **Preferences →
  Computer → Computer agent model** (default: the conversation's). Its `cu_*`
  tools use the same `sessionId`, so the banner, the chip, the thumbnail
  and a recording in progress see what it does, and the permissions show up in the
  conversation. Recording and permissions stay with the main agent.

## Recording: what changed after the Chrome test

- **Brings the window to the front** when starting (`bring_to_front`, default
  true): activates the app and does `AXRaise` on the window. Recording with the window
  behind, the person did not notice it had started.
- **Pulse only on click.** On scrolling, the "target" is the center of the window, and the video
  filled with yellow squares.
- **Cursor drawn in directed mode.** A macOS-style arrow slides from
  target to target (450 ms, smoothed) and arrives at the instant of each action. In global
  mode it does not appear, because the real cursor is already in the video. Validated with
  ffmpeg: a still on the 1st target, in the middle of the path and on the 2nd target.
- **Global pointer warns.** The banner says "Orbit is using your mouse on … —
  do not touch". In the test, the global pointer was on, and the agent and the person
  fought over the same cursor, which showed up mixed in the video.

## macOS permissions

| Permission | For what | Without it |
|---|---|---|
| Accessibility | AX tree, AX actions and keyboard/mouse events | Nothing works (`axDenied`) |
| Screen Recording | Screenshot (`screencapture -l`) and window titles | Only the tree (the text warns) |

TCC assigns the permission to the **responsible process**: the child `osascript` and
`screencapture` inherit Orbit's. In development the owner is the **Electron**
binary, not Orbit, and the item shows up as "Electron" in Settings. The
**Test** button in Preferences does a real read through the child process, which
proves the inheritance for real. The `isTrustedAccessibilityClient` flag alone does not
prove it. On Sequoia, Screen Recording goes back to asking for confirmation
periodically.

**Screen Recording request.** **Request** calls `CGRequestScreenCaptureAccess`
through the bridge, that is, in a child of Orbit, so the request goes out in its name. If
it does not come, Preferences explain the manual path. In the installed 0.1.4 build
(not notarized), macOS denied the request "by policy", with no dialog and without putting
Orbit in the list. Only the list's **+** solved it. An old build with the template's
default identifier (`YourAppID`, release 0.1.1) also appeared
as "Orbit" in both lists and confused the test.

We do not use System Events, so neither `NSAppleEventsUsageDescription` nor
the `com.apple.security.automation.apple-events` entitlement are needed. If
some path starts using it, both go in together.

## Stage 0: measurement

The spike measures the bridge before any product decision:

```bash
node apps/desktop/scripts/cu-probe.mjs --runs 5
node apps/desktop/scripts/cu-probe.mjs --frozen
```

**Approval criteria** (fixed before measuring):

| Criterion | Approved if |
|---|---|
| Observe latency | p95 < 1.5 s with 250 nodes in Safari and TextEdit (cold bridge) |
| Chromium | Non-empty tree in Chrome and VS Code with the accessibility flag |
| Timeout | Frozen app (SIGSTOP) responds in < 3 s, with a partial tree |
| Background click | Works in ≥ 1 Chromium app and 1 native one without moving the cursor (smoke) |
| TCC | Orbit's permission applies to the children, in dev and in the signed build |
| Capture | p95 < 600 ms per window |

If the latency or TCC fail, decision 2 is reopened and the Swift helper comes in.
If only the background click fails, the "directed" pointer stops being
the default for Chromium apps.

### Results

Measured on 2026-10-23, Darwin 25.4.0 (Apple Silicon), by the project's Electron 44.3.0
opened by LaunchServices (the same permission path as Orbit in
dev), 5 runs per measurement:

| Criterion | Result | |
|---|---|---|
| Observe latency | TextEdit: p95 **166–196 ms**. Safari (250 nodes): p95 **390–421 ms**. Claude/Electron (250 nodes): p95 **342–346 ms** | ✓ |
| Chromium | Electron (Claude): **13 nodes** read right after turning `AXManualAccessibility` on → **250+** after ~300 ms | ✓ (with a wait the 1st time) |
| Timeout | Frozen app (SIGSTOP): response in **615–623 ms**, actionable `axTimeout` error (the window list no longer responds, so there is no partial tree) | ✓ |
| Background click | Mouse event **by pid is ignored** by AppKit (TextEdit, neither in front nor behind). Hit-test + AXPress/focus by AX: ✓ in the background, cursor still | ✓ with a design change |
| Background keyboard | Unicode by pid (accents, ✓, 👍🏽) arrives with the app behind | ✓ |
| Background scrolling | Wheel by pid ignored; scroll bar by `AXValue`: ✓ (300 px → content goes up 306 px) | ✓ with a design change |
| TCC | Child `osascript` assigned to Orbit's Electron (`tccd` log) and with `accessibility: true` | ✓ in dev; signed build not measured yet |
| Capture | TextEdit p95 **107–109 ms**, Safari **191–197 ms**, Electron **145–158 ms** | ✓ |

Fixed costs: starting `osascript` ~55 ms, minimal bridge invocation ~115 ms,
apps and windows list p95 ~150 ms.

**What Stage 0 changed in the code:**

1. **Tree conversion 4x faster.** Safari took a p95 of 1.2 to 2.8 s
   (rejected). The final numbers above are already from the fixed bridge. The profile showed 65% of the time converting JXA → JS values
   (several `isKindOfClass` per attribute and `description` on every missing
   attribute). Replaced by a shallow `ObjC.unwrap` of the array and one per item. The
   `AXURL` left the batch request and is only read on links and web areas. Result:
   ~830 ms → ~190 ms of conversion, and a p95 of 390 ms in Safari.
2. **AXValue frame.** The `unwrap` of an AXValue is an empty `{}`, not
   `undefined`, and that is why position and size come from the raw value. The tests with a
   fake driver did not catch that; the smoke did.
3. **Unicode text.** `CGEventKeyboardSetUnicodeString` received the JS string and
   discarded it: every character became key 0 ("a"). The function was rewired
   with `ObjC.bindFunction(... 'void*')`, with the UTF-16 bytes of an `NSData`.
4. **Directed mode without a mouse.** Since AppKit ignores mouse and wheel events by pid, the
   click by coordinate in directed mode became an AX hit-test
   (`AXUIElementCopyElementAtPosition` → AXPress/AXShowMenu or focus on a text
   field, going up to 4 ancestors) and scrolling became the AX scroll bar
   (with Page Up/Down as a fallback). Double click, middle click, hover and drag
   now require the global pointer, with an explanatory error. It is the same cut as
   OCU.
5. **Action without confirmation.** An action that opens an animation or a dialog may
   answer -25204 having already run (the fullscreen button entered fullscreen
   and answered -25204). Now that counts as "probably executed", and the
   bridge does not try another action nor the ancestor.
6. **Chromium.** The first read after turning the flag on waits 450 ms.
   `AXEnhancedUserInterface` was left only for Chromium browsers, because in a native
   app it messes with window animation. Chromium keeps the tree on
   even after `restore`.

**Pending:** directed click in real Chrome/VS Code (they were not open;
the Electron measured was the Claude app, read-only) and TCC in the signed build.

**How to measure through the same path as the app.** Running the probe through the project's Electron,
opened by LaunchServices, makes `osascript` inherit Electron's permission,
exactly as in Orbit in dev:

```bash
open -n -W -a "$PWD/node_modules/electron/dist/Electron.app" --env ELECTRON_RUN_AS_NODE=1 --stdout /tmp/cu-probe.txt --stderr /tmp/cu-probe.err --args "$PWD/apps/desktop/scripts/cu-probe.mjs" --runs 5
```

**Trap in dev: several "Electron".** Every Electron project on the machine has its
own `Electron.app` with an ad-hoc signature (`Identifier=Electron`), and TCC
ties the permission to the binary's hash. In Settings, they all show up as
"Electron": freeing another project's (here, Fracta's Electron 30.5.1) does not
free Orbit's (44.3.0). To create the right entry, the binary itself must
ask for the permission (`isTrustedAccessibilityClient(true)` and a call to
`desktopCapturer.getSources`). That is what the Preferences' "Request" button does.

To diagnose, the `tccd` log shows whom the permission was assigned to and the
verdict (`authValue`: 0 denied, 1 no entry, 2 allowed):

```bash
/usr/bin/log show --last 2m --style compact --predicate 'process == "tccd"' | grep -E "AUTHREQ_ATTRIBUTION|AUTHREQ_RESULT"
```

On 2026-10-23, the log confirmed that the child `osascript` is assigned to Orbit's
Electron (`responsible_path=…/Orbit/node_modules/electron/…/Electron`). The inheritance
works. What was missing was the right entry turned on in Settings.

**Orbit under `npm run dev` belongs to the terminal.** In the first test in the app, the
Preferences showed "not granted" with Electron freed. The chain was
`Electron ← node ← npm run dev ← zsh ← login ← Terminal.app`, and the `tccd` log
recorded all of Orbit's requests with `responsible=com.apple.Terminal`. Whoever
runs the app from a terminal needs to free **the terminal** (Terminal, iTerm,
VS Code…) in Accessibility and Screen Recording. Opening from Finder or from
LaunchServices makes the app itself the owner. Preferences → Computer show
that app (`responsibleApp()`: climbs through the parent processes up to the first `.app`).

**Without the tools, the agent improvised.** With Computer Use off in the
conversation, the agent offered `osascript` + System Events in bash, which goes
around the denylist, the approval per app and the password-field refusal. Now
the prompt, on macOS, says how to turn it on and forbids the improvisation, and the gate asks for
approval for `osascript` with System Events (`bash:gui-automation`).

The lesson for the product: the permission belongs to whoever **launches** the child
process. Orbit calls `osascript` directly through `child_process`, so it inherits the
app's own. A wrapper that declares itself responsible (like Claude's `disclaimer`)
would break that inheritance.

## How to validate

1. Grant Accessibility and Screen Recording to the project's Electron and run the
   probe and the smoke through it (Claude Code's terminal does not work: the `disclaimer`
   in the middle of the chain makes it the owner of its own permissions):
   ```bash
   open -n -W -a "$PWD/node_modules/electron/dist/Electron.app" --env ELECTRON_RUN_AS_NODE=1 --stdout /tmp/cu-smoke.txt --stderr /tmp/cu-smoke.err --args "$PWD/apps/desktop/scripts/cu-smoke.mjs" --act
   ```
   The smoke only acts on a new TextEdit document that it opens itself.
2. In the app: Preferences → Computer → turn it on, grant the permissions to
   Orbit/Electron, click **Test**.
3. In a conversation with Computer mode on, ask for something like "open TextEdit and
   write a shopping list". The expected: the approval card, the top banner,
   the chip with Stop, and ⌘⇧. interrupting the turn.

Automatic tests (`vitest`, with a fake driver, without touching the OS):
`electron/lib/computer/*.test.ts`, `permission/rules.test.ts`,
`permission/global-mode.test.ts` and `app-settings.test.ts`.

## Outside v1

- **Windows**: plan and state in [computer-use-windows.md](computer-use-windows.md).
- **Linux**: AT-SPI via PyGObject. The dependence on
  `python3-gi`, the accessibility enabled and Wayland (capture and injection only
  through a portal, best-effort) are left for its plan.
- Routines, pipeline and mobile, virtual display, `select_text` and a "Computer"
  tab in the right panel (polishing Stage 2). The drawn cursor left
  the plan: see "Cursor on the global pointer".
