# Computer Use on Windows

Plan and state of Orbit's Computer Use on Windows. The macOS design (tools
`cu_*`, numbered observation, registry, security, panels and recording) is in
[computer-use.md](computer-use.md) and does not change: Windows comes in as **one more
driver** behind the same `ComputerDriver` contract
(`apps/desktop/electron/lib/computer/types.ts`).

> **State:** Stages 1 to 4 written. What runs on the Mac (TypeScript: contract,
> persistent runner, driver, UI gates, security) is covered by typecheck,
> lint and vitest with a fake driver. **The host (`windows.ps1`, `windows-host.cs`,
> `windows-host-actions.cs`) has never been compiled nor executed**: this machine is
> a Mac. It only went through a C# parser (syntax) and through a test of the probe
> against a fake host. **The first `node scripts/cu-probe-win.mjs` on a
> Windows is also the first `Add-Type`**: expect C# compilation errors
> before any number. Until the Stage 0 gate passes, Windows is
> **experimental**: the numbers and the background behavior per app type
> are hypotheses.

### How to test on Windows

1. Install the dependencies and run the app in dev (`npm run dev` in `apps/desktop`).
   In Preferences → Computer the tab shows up on Windows; the "Windows" block says whether
   the UI Automation host came up (or why not: restricted PowerShell, etc.). The
   "Test" button does a real read of the front app.
2. Turn on "Control the computer" and, in the conversation, Computer mode in the composer.
3. Run the probe with the apps open (see the header of
   `apps/desktop/scripts/cu-probe-win.mjs`) and keep the `cu-probe-win-report.json`.

## Reference and license

We use the Windows runtime of open-computer-use
(`apps/OpenComputerUseWindows`, MIT) **only as reading**: how they solved
DPI awareness, `EM_REPLACESEL`, window messages, the order of attempts in the
click and which scenarios the tests cover. The code here is ours, with another
design:

| Point | open-computer-use | Orbit |
|---|---|---|
| Process | one `powershell.exe` per operation (~1–2 s of `Add-Type` every time) | **persistent host**: one process, `Add-Type` once, JSON per line |
| Logic | PowerShell functions iterating the UIA | C# compiled by `Add-Type`; PowerShell only starts the loop |
| Tree | `Current.*` element by element | **`CacheRequest`** (one round-trip per expanded node) |
| Capture | `CopyFromScreen` (grabs whatever is on top) | **`PrintWindow(PW_RENDERFULLCONTENT)`**; `CopyFromScreen` only if the window is not covered |
| Rectangle | `GetWindowRect` (includes the ~7 px invisible border) | **`DWMWA_EXTENDED_FRAME_BOUNDS`**, a single one for apps, capture and frames |
| Finding the element | scans the subtree on every click | the observation's **`ref`** (map in the host), `path` as fallback |
| `SetFocus` / open app | behind an environment variable | never `SetFocus`; opening an app is a normal action with approval |
| Capture output | base64 in the JSON | file path |

No snippet was copied. If someday a snippet becomes similar enough
to count as derived, their project's MIT copyright notice goes along
in the file.

## Architecture

```
tools/computer.ts ── observe.ts / act.ts / format.ts / registry.ts / safety.ts
                                   │  (ComputerDriver)
               ┌───────────────────┴───────────────────┐
     drivers/macos.ts                         drivers/windows.ts
     createBridgeRunner (1 osascript/op)      createPersistentRunner (1 host)
     bridges/macos.js (JXA)                   bridges/windows.ps1 (PowerShell + C#)
```

### Persistent host (`bridges/windows.ps1`)

- Runs on `powershell.exe` 5.1 (always present on Windows 10/11; the managed
  `System.Windows.Automation` and the `JavaScriptSerializer` come from .NET
  Framework, not from PowerShell 7).
- At startup: checks the `LanguageMode` (Constrained Language Mode blocks
  `Add-Type` — the host answers `unavailable` with the reason to every request), turns on
  `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` and compiles the C# **once**.
- Protocol: one JSON line per request on stdin
  (`{"id":7,"op":"tree","args":{…}}`), one line per response on stdout
  (`{"id":7,"ok":true,"result":…}` or `{"id":7,"ok":false,"error":{"code","message"}}`).
  stdin and stdout are opened as UTF-8 without BOM — PowerShell 5.1 uses the ANSI code
  page by default and would corrupt non-ASCII text typed.
- State in the host: `ref → AutomationElement` per pid, swapped on every tree
  of that pid (generation counter in the `ref`), and the `focus`'s "text target"
  (see Stage 3).

### Runner (`runner.ts → createPersistentRunner`)

Same signature as `createBridgeRunner`: `run(op, args, { timeoutMs, signal })`.

- Starts the host on first use (the first request gets an extra deadline for the
  `Add-Type` compilation).
- Correlates responses by `id`; the host is sequential, the requests wait in the
  stdin queue.
- Timeout or abort of an operation: **records the outcome before the kill** (the
  `close` caused by the kill cannot turn "timeout" into "exited without an
  answer"), kills the host and rejects the other pending requests with a
  "host restarted" message. The next use starts a new host.
- Unexpected death: rejects everything that is pending with the end of stderr.

### Coordinates and DPI

The host is **per-monitor DPI aware v2**. With that, UIA (`BoundingRectangle`,
`FromPoint`), `DwmGetWindowAttribute`, `PrintWindow`, `SendInput` and
`ScreenToClient` speak the virtual desktop's **physical pixel**. The contract's `Frame`
on Windows is physical pixel, and the screenshot already comes out at the frame's size.
That is why `scaleFor` is **1** on win32 (`tools/computer.ts`): on the Mac it is 2 on
Retina because AX speaks points and the screenshot pixels.

The only place where DIP enters is Electron (`screen`, `BrowserWindow`): the
bar and the panels use the monitor's usable area in DIP, without the target window's frame.
If someday we need to draw over the target window, the conversion is
`physicalToDip()` in `geometry.ts` (tested with 150%).

### Element identity (`ref`)

`AxNode.ref?: string`. On Windows:

- `r:<generation>:<RuntimeId in base64>` — resolves through the host's map;
- `k:<AutomationId>|<ControlType>|<Name>` — when there is no RuntimeId; resolves by
  a search under the window.

`act.ts` sends `ref` when it exists and `path` (child indices in the Control View
from the window) as a fallback. The host **always** checks the identity
(native role and name) of what it found: if it does not match, it returns `staleIndex`; if the
element is dead (`ElementNotAvailableException`) and the `path` does not work either,
`staleRef`. It never clicks the wrong element. macOS ignores `ref`.

The handle keeps `nativeRole` (the role as the host sent it) besides the normalized
`role`: the host checks identity in its own vocabulary.

### Roles

UIA speaks `ControlType` (`Button`, `Edit`, `Document`…). The host sends the raw
name; `format.ts → normalizeRole()` translates it into the AX vocabulary that the rest
of the module (and the prompt) already knows:

| UIA | AX | Observation |
|---|---|---|
| `Document` | `AXWebArea` | with a URL, or read-only |
| editable `Document` | `AXTextArea` | Windows 11 Notepad is `Document` |
| `Edit` | `AXTextField` | |
| `Hyperlink` | `AXLink` | |
| `Text` | `AXStaticText` | |
| `Pane`, `Group`, `Custom`, `TitleBar` | `AXGroup` / `AXUnknown` | disappear from the tree if they say nothing |
| `Tab` / `TabItem` | `AXTabGroup` / `AXTab` | |
| `Tree` / `TreeItem` | `AXOutline` / `AXTreeItem` | |
| `ListItem`, `DataItem` | `AXListItem`, `AXRow` | |
| the rest | equivalent `AX<Name>` | full table in `format.ts` |

Actions also become the AX vocabulary: `Invoke` and `Toggle → AXPress`,
`SelectionItem → AXPick`, `ExpandCollapse → AXExpand/AXCollapse`. `AXPress`
tries Invoke, then Toggle, SelectionItem and ExpandCollapse. The `Toggle` state appears
as a value (`1`/`0`) and the `SelectionItem` one as `selected`.

### Keys

`keys.ts` is per platform. On Windows the combo is `{ code: VK, flags }` with flags
`shift=1, ctrl=2, alt=4, win=8`. `cmd`/`command` become **Ctrl** (the model sends
`cmd+s` out of Mac habit); `win`/`super`/`meta` become the Windows key.

### New errors

| Code | When | What the model hears |
|---|---|---|
| `elevated` | the app runs as administrator (UIPI blocks messages and `SendInput` from a regular process) | ask the user to do it, or open Orbit as administrator — never work around it |
| `secureDesktop` | UAC, lock screen or Ctrl+Alt+Del (the input desktop is not `Default`) | stop and ask the user |
| `staleRef` | the `ref`'s element no longer exists | observe again |

## Operations table

| op | Windows | macOS (reference) |
|---|---|---|
| `perms` | `LanguageMode`, UIA loaded, Orbit's integrity level | TCC |
| `apps` | `EnumWindows` (z-order = front→back) + `DWMWA_CLOAKED` + `WS_EX_TOOLWINDOW` + owner; `ApplicationFrameHost` resolves to the `CoreWindow`'s process (UWP); name by `FileDescription`, id by exe (or AUMID) | `NSWorkspace` + `CGWindowList` |
| `tree` | `CacheRequest` + children in the Control View, BFS with `maxNodes`/`maxDepth`/deadline; `ref`, `secure` (`IsPassword`), URL from Chromium's address bar | AX BFS |
| `capture` | `PrintWindow(PW_RENDERFULLCONTENT)` cropped to the DWM frame; black → `CopyFromScreen` only if the window is not covered; otherwise, no image | `screencapture -l` |
| `element` | `ref` → `path`; `press` (Invoke/Toggle/SelectionItem/ExpandCollapse, on a thread with a deadline: an Invoke that opens a modal blocks), `setValue` (ValuePattern/RangeValue), `select` (TextPattern `FindText` + `Select`; Win32 Edit by `EM_SETSEL`), `focus` (a no-op that only stores the text target), `info` | AX |
| `hit` | `AutomationElement.FromPoint`, checking that it belongs to the pid and the window (covered → nothing, and `act` falls back to a message) | AX hit-test |
| `focused` | `GetGUIThreadInfo(hwndFocus)` → UIA; also `ES_PASSWORD` in the Edit | `AXFocusedUIElement` |
| `selection` | `TextPattern.GetSelection` + `MoveEndpointByRange` to the `location` | `AXSelectedTextRange` |
| `scrollAx` | `ScrollPattern` on the ancestor under the point (`SetScrollPercent` computed from `ViewSize`) | AX scroll bar |
| `mouse` | **global only**: `SendInput` with a cursor slide. No window message (decision: see "Input decision") | CGEvent |
| `scroll` | directed: `ScrollPattern` (`scrollAx`); global: `SendInput` | CGEvent |
| `drag` | global only (`SendInput`) | global only |
| `keys` | global only: `SendInput` per VK and `KEYEVENTF_UNICODE` for text. Text in directed mode goes through `set_value`/`ValuePattern`, with `EM_REPLACESEL` only as a fallback in a native Edit/RichEdit | CGEvent per pid |
| `openApp` | already open → brings it to the front; otherwise path, App Paths, Start Menu shortcut or `shell:AppsFolder` (UWP), waiting for the window | `open -a/-b` |
| `restore` | no-op (there is no flag to turn off) | `AXManualAccessibility` |

No `SetFocus` anywhere: on Windows, focusing another app's control
**activates the window** and steals the user's keyboard. That is why `focus` becomes a
successful no-op that only stores the element as the target of the next typing
from that pid (expires in 10 s).

### Input decision: directed mode is UI Automation only

Posted window messages (`PostMessage` of mouse and keyboard) and the modifier
trick (`AttachThreadInput` + `SetKeyboardState`) fail silently in
Chromium, UWP and WPF and are the pattern EDR flags as suspicious. That is why, as
on macOS (Stage 0), directed mode goes **only through UIA**:

1. Element by index: UIA pattern (`press`: Invoke, Toggle, SelectionItem,
   ExpandCollapse).
2. Point: `hit` + UIA pattern on the element under the point.
3. No pattern: an error explaining that directed mode only clicks on controls, and
   offering the global pointer.
4. Global pointer (opt-in in Preferences): `SendInput`, which moves the real
   cursor and brings the app to the front, with the bar warning.

`capabilities().messageMouse` stays `false` in the Windows driver (the generic path
in `act.ts` remains covered by a test, in case Stage 0 shows it is worth
turning on for some app type). Background text goes through `set_value`
(ValuePattern) and, in native Edit/RichEdit fields without ValuePattern, through
`EM_REPLACESEL`. `focus` never uses `SetFocus`.

## Stages

### Stage 0 — measurement (gate) ⏳ still to be run on a Windows

`node apps/desktop/scripts/cu-probe-win.mjs` (see the script's header). It
starts the same host, opens the test apps and writes a JSON + text report.

**Latency**

| Measurement | Target |
|---|---|
| Chrome tree (~1500 nodes), with `CacheRequest` | < 800 ms |
| The same tree without `CacheRequest` (comparison) | record |
| Chrome capture **covered**: `PrintWindow` vs `CopyFromScreen` | < 150 ms, and the image is Chrome's |
| Click (element by `ref`) | < 150 ms |
| Host startup (`Add-Type`) | record (paid once) |

**Background input, per app type** — the point the original analysis
forgot. On macOS Stage 0 showed that mouse and scrolling by pid were ignored and
directed mode had to go entirely through accessibility. On Windows, Chromium, UWP
and WPF may ignore synthetic mouse messages or not deliver `WM_CHAR` to
the focused element. For each app — **Notepad (Win32/RichEdit), Explorer,
Chrome, an Electron app, Calculator (UWP), a WPF app, Excel** — with the window
**behind another** (the probe also measures the window messages as an
experiment, to decide whether `messageMouse` is turned back on):

| Scenario | How the probe checks |
|---|---|
| click by UIA pattern | the state changed (Toggle, value, new window) |
| click by message | the same |
| `WM_CHAR` / `EM_REPLACESEL` / `ValuePattern` | re-reading the value |
| key with modifier (`ctrl+a`) by `AttachThreadInput` | selection read by the TextPattern |
| scrolling by `ScrollPattern` and by `WM_MOUSEWHEEL` | `VerticalScrollPercent` changed |
| did the app stay behind? | `GetForegroundWindow` did not change |

**Environment**

- PowerShell in Constrained Language Mode → the probe reports it and the host refuses with a
  clear message.
- Elevated app (opening Notepad as administrator) → `elevated`.
- DPI at 150% on a second monitor → the DWM frame, `FromPoint` and the capture match
  (the probe clicks the center of a button on the 150% monitor).
- `desktopCapturer` (Windows Graphics Capture) records a covered window? Does the yellow
  border show up?

**Acceptance criterion:** all latencies within the target and one decision
recorded per app type: what works in the background, what requires the
global pointer, what does not work. That table becomes code (lists per window
class in the host) and text in the prompt.

### Stage 1 — contract ✅

- `ref?: string` in `AxNode` and in `ElementHandle` (+ `nativeRole`); `act.ts`
  sends `ref` and `path`.
- optional `window.id` in `TreeRequest`/`element` (the `HWND`); macOS ignores it.
- `keys.ts` per platform.
- honest `capabilities()`: `messageMouse` (mouse by message reaches the app) —
  `false` in both; Stage 0 can turn it on for Windows per app type.
- `perms()` with `notes` (CLM, integrity).
- `AppInfo.elevated`; errors `elevated`, `secureDesktop`, `staleRef`.
- `normalizeRole()` in `format.ts`.
- `scaleFor = 1` on win32.

**Acceptance:** macOS with no behavior change (green suite); tests of
`normalizeRole`, `parseKeys('ctrl+s', 'win32')` and of `ref` in `act`.

### Stage 2 — driver and host ✅ (not compiled, not measured)

- `bridges/windows.ps1` (starts the host, UTF-8, Constrained Language Mode),
  `windows-host.cs` (`perms`, `apps`, `tree`, `capture`) and
  `windows-host-actions.cs` (the actions), compiled together by `Add-Type`;
  `createPersistentRunner()`; `drivers/windows.ts`, which writes the three files
  into a folder with the content hash.
- `apps`, `tree`, `capture` as in the table.

**Acceptance on the Mac:** tests of the persistent runner with a fake process
(correlation by id, a timeout that kills and comes back, abort, host death, split
lines and UTF-8) and of the protocol parse. **On Windows (Stage 0):** latencies.

### Stage 3 — actions ✅ (not compiled, not measured)

Everything from the operations table. Background text (`type` in directed mode)
goes through `EM_REPLACESEL` in a native Edit/RichEdit or through ValuePattern, replacing the
selection (TextPattern) or appending to the end; keyboard shortcuts, free mouse,
drag and wheel only on the global pointer. `openApp` only opens a real app (never
executes the string received). **Acceptance on Windows:** the Stage 0 background input
table filled in.

### Stage 4 — wiring ✅

- `computerSupport()` per platform and driver factory in `computer/index.ts`.
- UI gates that required darwin: `src/stores/computer-mode.ts`,
  `src/components/appearance-panel.tsx`, `src/components/settings-dialog.tsx`;
  the Preferences panel shows "Windows does not ask for permission" in place of
  Accessibility/Screen Recording.
- `safety.ts`: denylist by exe/AUMID (password managers, Windows
  Security, UAC `consent.exe`, Settings, `CredentialUIBroker.exe`, lock
  screen) and browsers by exe.
- `computerStatus` without `systemPreferences` on Windows.
- Prompt without "macOS", with permissions and shortcuts per platform
  (`computerInstruction(platform)` in `prompts.ts`). **Pending commit:** this
  snippet and its test (`prompts-computer.test.ts`) depend on the new macOS
  prompt text (computer_task, cu_batch) that has not been committed yet by the
  session that owns it; they stay in the working tree until then.
- The approval gate warns, in the request, when a browser has no readable site
  (approving applies to all tabs), and `bash` with PowerShell/UI Automation goes
  through the same gate as `osascript`.
- Bar and panels: `type: 'panel'` is macOS only. On Windows, `focusable: false`
  becomes `WS_EX_NOACTIVATE` in Electron: clicking Stop or a panel does **not**
  bring Orbit to the front.
- Panic shortcut: **Ctrl+Shift+.** on Windows. It does not collide with a
  system shortcut (Win+. is the emoji panel; Ctrl+Shift alone switches the layout, but with
  `.` it does not). While the control is active it is global and "steals" the shortcut from
  apps that use it (VS Code: breadcrumbs; Word: increase font is Ctrl+Shift+>).
  The `Ctrl+Shift+Esc` reserve is **not** registered on Windows: it is Task
  Manager.

## Risks

**Per-site approval in browsers.** On macOS the URL comes from `AXWebArea`;
**UIA has no URL**. The host reads Chromium's address bar (Chrome, Edge,
Brave, Vivaldi, Opera: the bar's `Edit`, by `AutomationId`/name, through
`ValuePattern`) **only when it does not have focus** — with focus, the value is what
is being typed, not the page. Without a scheme (Chrome hides `https://`), the
driver completes it. Firefox does not expose this reliably. When there is no URL,
Windows **degrades to per-app approval**, and that shows up:

- in the approval request ("applies to ALL tabs of this browser");
- in the prompt (the agent warns the user before switching sites).

**Background input.** Directed mode goes only through UI Automation (see
"Input decision"): click by pattern, text by `EM_REPLACESEL`/ValuePattern,
scrolling by ScrollPattern. What has no pattern (click on a free area, keyboard
shortcut, hover, drag, wheel) requires the global pointer and brings the app to the
front. Risk: apps that expose little UIA (Chromium without the tree on, games,
hand-drawn apps) end up almost only on the global pointer. The window messages
(which Chromium, UWP and WPF probably ignore, and which EDR sees as
suspicious) are measured by the probe as an experiment, not used.

**Black `PrintWindow`** in apps with GPU acceleration (some games, players,
Chromium with certain flags). We detect an all-black image and fall back to
`CopyFromScreen` only if the window is uncovered; otherwise the observation comes out without an
image and with the reason — better than showing another window.

**Recording.** `desktopCapturer` uses Windows Graphics Capture and should grab the
covered window; the source `id` is `window:<HWND>:0`, the same number as our
`WindowInfo.id`. Windows draws a **yellow border** around the captured window
(on Windows 11 it can be removed with `IsBorderRequired = false`, which
Electron does not expose). To be confirmed in Stage 0.

**Managed UIA.** `System.Windows.Automation` is slower than the
`IUIAutomation` COM and sometimes loses Chromium elements. If Stage 0 rejects the
tree, the next step is talking COM directly from C# (without changing the protocol).

**Synchronous `Invoke`.** A button that opens a modal dialog can hold the `Invoke`
until the dialog closes; the host calls it on a thread with a deadline and returns
`unconfirmed`.

**Antivirus/EDR.** PowerShell with `Add-Type`, `SendInput` and `PrintWindow` in
other processes looks like malware behavior to some EDRs. Record in
Stage 0 whether Defender complains; the long-term way out is a signed native
helper.

**UIPI and secure desktop.** There is no way to (nor should one) act on an elevated app or on
UAC from a regular process: we refuse with a clear message (`elevated`,
`secureDesktop`) and `consent.exe` is on the denylist.

## How to validate

On the Mac (what runs today):

```bash
cd apps/desktop && npx tsc --noEmit && npm run lint && npx vitest run
```

On Windows (Stage 0):

```bash
cd apps/desktop && node scripts/cu-probe-win.mjs --out cu-probe-report.json
```
