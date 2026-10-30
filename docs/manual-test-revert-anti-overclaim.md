# Manual Test Script — Revert (Part B) & Anti-overclaim (Part A)

**App:** Orbit (desktop, Electron + React) · **Tested version:** v0.1.0
**Script date:** 2026-08-11 · **Language:** pt-BR (the quoted strings are from the pt-BR locale — see Annex A)

> **Feature status (verified in the code on 2026-08-11):**
> - **Part B (scenarios 1–5):** implemented — `apps/desktop/electron/lib/session/revert.ts`, `apps/desktop/src/components/revert-bar.tsx`, `packages/shared/src/chat.ts` (`SessionRevert` type).
> - **Part A (scenarios 6–9):** `verify_changes` and `session_context` are **not in the code** yet (being implemented). The script describes the behavior expected by specification — if the scenario fails for lack of implementation, report it as a "missing feature", not as a regression.
> - **Scenario 5 (flag `snapshot.failed`):** the message footer already renders the warning when the flag exists (`message-footer.tsx`), but `chat-engine` does not set `failed: true` on a capture failure yet — scenario 5 may fail until that implementation.

---

## 0. Prerequisites

| # | Requirement | How to check |
|---|-----------|---------------|
| 0.1 | Node.js 20+ and npm installed | `node -v && npm -v` |
| 0.2 | Monorepo dependencies installed (project root) | `npm install` at the root (`/Users/desknik/Projects/Orbit`) |
| 0.3 | `git` installed and available (the snapshot feature uses an auxiliary git repo) | `git --version` |
| 0.4 | Model provider configured in the app, with a model **that supports tools** (tool calling) | Models tab → selected model with the tools badge |
| 0.5 | Isolated test folder for the script (the agent will edit files in it) | E.g.: `~/orbit-teste-manual/` |
| 0.6 | App language: **Portuguese (BR)** (otherwise the exact strings of the expected results change) | Preferences → Language |

**Test folder preparation (once):**

```bash
mkdir -p ~/orbit-teste-manual
printf 'linha original\n' > ~/orbit-teste-manual/ola.txt
cat ~/orbit-teste-manual/ola.txt   # must show: linha original
```

---

## 1. Start the app in dev

From the monorepo root (`/Users/desknik/Projects/Orbit`):

```bash
npm run desktop:dev
```

- Equivalent to `npm run dev --workspace=@orbit/desktop` (Vite + Electron, hot reload).
- **Leave this terminal open** — it receives the main process logs (important for "how to report a failure").
- The app opens in an Electron window. Wait for the interface to load before testing.

> Alternative: `cd apps/desktop && npm run dev`.

---

## 2. Preparing the test session (code mode)

Repeat at the start of each Part B scenario (or use the cleanup step at the end of each scenario):

| Step | Action | Expected result |
|-------|------|--------------------|
| 2.1 | In the app, create a **new session in code mode** and attach the folder `~/orbit-teste-manual` as a working folder | Session created; the folder shows up as the session's working folder |
| 2.2 | Send: `Leia ola.txt e me diga o conteúdo.` | The agent reads the file and answers with "linha original" |
| 2.3 | Wait for the turn to finish (spinner stops / idle status) | Turn completed without errors |

**Cleanup between scenarios:** use the revert bar's **"Desfazer"** button (if active) or **delete the session** and create another one. **Never** edit the session/message JSON with the app open — the app may overwrite them.

---

## 3. Part B — Revert (scenarios 1 to 5)

### Scenario 1 — Revert to here with a snapshot available (happy path)

**Goal:** in code mode, edit a file and revert to the question: the file goes back to its original state and the bar shows "1 arquivo revertido".

| Step | Action | Expected result | Acceptance criterion |
|-------|------|--------------------|--------------------|
| 1.1 | Create the test session (section 2) | Session in code mode with the original `ola.txt` | `ola.txt` contains only "linha original" |
| 1.2 | Send: `Adicione a linha "LINHA_ADICIONADA" no final de ola.txt.` and wait for it to finish | Turn completed; the assistant message's footer shows **"Arquivos alterados neste turno:"** with `ola.txt (1 diff)` | The footer (A3) lists exactly `ola.txt` |
| 1.3 | Check on disk: `cat ~/orbit-teste-manual/ola.txt` | Content has both lines (original + added) | The edit was really written |
| 1.4 | Hover over the **user message** and click **"Reverter até aqui"** | The conversation is truncated from that message on; the messages of the reverted turn disappear | Only the reverted turn (and the later ones) is removed; previous messages stay |
| 1.5 | Observe the bar above the input | The bar shows **"1 arquivo revertido — nova mensagem continua deste ponto"** with the **"Diff"** and **"Desfazer"** buttons | Exact text: "1 arquivo revertido" (singular) |
| 1.6 | Click **"Diff"** on the bar | Opens the unified diff showing the removal of the added line | The diff matches what was reverted |
| 1.7 | Check on disk: `cat ~/orbit-teste-manual/ola.txt` | The file went back to the original state ("linha original") | The filesystem was restored (not only the conversation) |
| 1.8 | *(Optional, state check)* With the app closed, open `orbit-data/storage/session/<id>.json` | Field `"revert"` present with `"filesRestored": true`, `"files"` and `"diff"` filled | The revert state was saved (the basis for scenario 4) |

> Do **not** click "Desfazer" yet — scenario 4 needs the active state. If you are going straight to scenario 2/3, do the cleanup indicated.

### Scenario 2 — Revert to a message without a snapshot → explicit warning (never a silent revert)

**Goal:** in code mode, when there is no snapshot for the reverted message, the app **must warn explicitly** that the conversation was truncated but the files **could not** be undone — never do a silent revert in a code session.

**Preparation (simulate a message without a snapshot — method A, deterministic):**

1. Close the app.
2. Locate the session's messages JSON:
   ```bash
   find ~/Library/Application\ Support -maxdepth 4 -type d -name orbit-data 2>/dev/null
   # → <userData>/orbit-data/storage/messages/<sessionId>.json
   ```
3. Open `messages/<sessionId>.json` and, in **one assistant message** (e.g. the 2nd turn's answer), **remove the whole `"snapshot"` field**. Save.
4. Reopen the app and enter the session.

> Alternative method (B, without editing JSON, but with a short window and it may not reproduce): send a prompt and click "Reverter até aqui" on the **just sent** user message, before the assistant's answer gets a snapshot. If it does not reproduce, use method A.

| Step | Action | Expected result | Acceptance criterion |
|-------|------|--------------------|--------------------|
| 2.1 | Prepare the session as above (assistant message without `snapshot`) | Session with an "old" turn without a snapshot | `messages/<id>.json` has at least one assistant message without the `snapshot` field |
| 2.2 | Hover over the message of the **user before the answer without a snapshot** and click **"Reverter até aqui"** | The conversation is truncated (the turn's messages disappear) | The truncation of the conversation **happens** (normal revert behavior) |
| 2.3 | Observe the bar above the input | Bar with an **amber alert** icon and the exact text: **"A conversa foi truncada, mas as alterações de arquivo NÃO puderam ser desfeitas (snapshot indisponível para esta mensagem)."** | Explicit and visible warning — **never** a silent revert in a code session |
| 2.4 | Check on disk: `cat ~/orbit-teste-manual/ola.txt` | The file **still** has the edits from the reverted turn (it was not restored) | No false restoration of files |
| 2.5 | *(State check)* With the app closed, open `session/<id>.json` | `"revert"` with `"filesRestored": false` and `"reason": "no-snapshot"` | The reason was recorded in the persisted state |
| 2.6 | **Cleanup:** reopen the app and click **"Desfazer"** (or delete the session) | The bar disappears; the messages come back | Clean state for the next scenario |

### Scenario 3 — Unrevert (Desfazer): files and messages come back

**Goal:** the bar's "Desfazer" restores the truncated conversation **and** the filesystem to the state before the revert.

| Step | Action | Expected result | Acceptance criterion |
|-------|------|--------------------|--------------------|
| 3.1 | Run scenario 1 up to step 1.6 (revert active, bar visible) | "1 arquivo revertido" bar active | Revert state active |
| 3.2 | Note down: number of visible messages and the content of `ola.txt` (it should be original) | "Reverted" state | — |
| 3.3 | Click **"Desfazer"** on the bar | The bar disappears; **the truncated messages reappear** (full conversation back) | All messages of the reverted turn are back, in order |
| 3.4 | Check on disk: `cat ~/orbit-teste-manual/ola.txt` | The file **has the "LINHA_ADICIONADA" line again** (edited state) | The filesystem was restored to the pre-revert state |
| 3.5 | *(State check)* With the app closed, open `session/<id>.json` | The `"revert"` field **absent** | The revert state was removed from the session |
| 3.6 | Send a new message and confirm that the session works normally | Turn runs with no traces of the bar/state | No ghost state |

### Scenario 4 — Persistence: close and reopen the app in the middle of the flow

**Goal:** the revert state survives closing/reopening the app (persisted on disk).

| Step | Action | Expected result | Acceptance criterion |
|-------|------|--------------------|--------------------|
| 4.1 | Run scenario 1 up to step 1.6 (revert active, bar visible) | "1 arquivo revertido" bar active; original `ola.txt` | Revert state active |
| 4.2 | Close the app (**Cmd+Q** — not just the window) | App terminates | — |
| 4.3 | Reopen with `npm run desktop:dev` | App opens normally | No startup error |
| 4.4 | Navigate to the **same session** | The bar is still visible: **"1 arquivo revertido — nova mensagem continua deste ponto"** | The revert state **persisted** |
| 4.5 | Check on disk: `cat ~/orbit-teste-manual/ola.txt` | Still in the original (reverted) state | The filesystem restore survived the restart |
| 4.6 | Check the conversation | Still truncated (the reverted turn's messages did not come back) | Persistence preserves the truncation |
| 4.7 | Click **"Desfazer"** | Messages and file come back (scenario 3 behavior) | The unrevert works **after** reopening the app |
| 4.8 | **Cleanup:** with the revert undone, go to scenario 5 | Clean state | — |

### Scenario 5 — Snapshot capture failure at the start of the turn → `snapshot.failed`

**Goal:** when the capture of the snapshot at the start of the turn fails, the UI/state **record the failure** (`snapshot.failed`) instead of silence.

| Step | Action | Expected result | Acceptance criterion |
|-------|------|--------------------|--------------------|
| 5.1 | Close the app | App terminates | — |
| 5.2 | Locate the test folder's auxiliary snapshot repo: `find ~/Library/Application\ Support -maxdepth 4 -type d -name snapshots 2>/dev/null` and identify the project's hash subfolder (the most recent/only one) | Folder `<userData>/snapshots/<hash>/` exists (created by the app on the first turn) | Auxiliary repo identified |
| 5.3 | Lock the repo to force the capture failure: `chmod -R 444 <userData>/snapshots/<hash>` | No output; permissions changed (`ls -l` shows `r--r--r--`) | The snapshot's `git add`/`write-tree` will start to fail |
| 5.4 | Reopen the app and, in the test session, send: `Adicione a linha "FALHA_SNAPSHOT" no final de ola.txt.` | The turn **completes normally** (a snapshot failure does not bring the turn down) | The tracking failure does not interrupt the agent |
| 5.5 | Observe the assistant message | The footer shows the warning: **"As alterações deste turno não puderam ser rastreadas."** | The failure is **visible** — never silence (no footer at all) |
| 5.6 | Observe the dev terminal (`npm run desktop:dev`) | Log with an error: `[snapshot] captura inicial falhou: ...` | The error was recorded in the main process |
| 5.7 | *(State check)* With the app closed, open `messages/<id>.json` and locate the turn's assistant message | Field `"snapshot"` with `"failed": true` (and without `start`) | The state records `snapshot.failed` |
| 5.8 | **Restore the environment:** `chmod -R 755 <userData>/snapshots/<hash>` | Normal permissions back | No side effects after the test |
| 5.9 | Reopen the app and run a normal editing turn | The footer lists the files normally again | Tracking recovered after restoring the permissions |

> **Implementation note:** today the footer already renders the warning when `snapshot.failed === true` (or `start == null`), but `chat-engine` does not set the flag in the `catch` of the initial capture yet — if step 5.5/5.7 fails because of that, report it as a "missing feature".

---

## 4. Part A — Anti-overclaim (scenarios 6 to 9)

> Scenarios 6, 7 and 9 describe features still being implemented. Before testing them, confirm with the team whether the local build already contains them.

### Scenario 6 — Nudge A1: editing without re-reading forces a continuation asking for `verify_changes`

**Goal:** if the agent edits a file and tries to end the turn **without** re-reading/verifying (without calling `verify_changes`), the app forces a continuation asking for the verification.

| Step | Action | Expected result | Acceptance criterion |
|-------|------|--------------------|--------------------|
| 6.1 | Create the test session (section 2) | Session in code mode | — |
| 6.2 | Send: `Edite ola.txt adicionando a linha "SEM_VERIFICAR" e termine por aí, sem reler o arquivo e sem verificar nada.` | The agent calls the edit tool and **tries to end** the turn right after | The turn does NOT end silently |
| 6.3 | Observe the turn's flow | The app **forces a continuation** in the same turn: a system/instruction message asking the agent to call `verify_changes` (e.g. "Você alterou ola.txt — chame verify_changes antes de concluir") | Forced continuation with an explicit mention of `verify_changes` |
| 6.4 | Observe the turn's sequence of tool calls | After the continuation, the agent calls `verify_changes` (see scenario 7) | No turn with an unverified edit ends in silence |

### Scenario 7 — `verify_changes` tool: with and without an edit in the turn

**Goal:** the `verify_changes` tool answers with the turn's real state: with an edit it returns the file with state/patchSize; without an edit it returns empty ("no change written").

| Step | Action | Expected result | Acceptance criterion |
|-------|------|--------------------|--------------------|
| 7.1 | (Turn **with** an edit) In the test session, send: `Adicione a linha "VERIFICA" ao final de ola.txt e depois chame verify_changes.` | The agent edits and calls `verify_changes` | The tool was called in the same turn as the edit |
| 7.2 | Open the tool call result in the chat (tool card) | The tool returns the file with state and patch size, e.g. `{"file": "ola.txt", "state": "modified", "patchSize": <n>}` (or an equivalent format with path + state + patchSize) | The data reflect the **real state** on disk (check with `cat ola.txt` and `wc -c`) |
| 7.3 | (Turn **without** an edit) Send: `Quantas linhas tem ola.txt? Depois chame verify_changes.` | The agent answers and calls `verify_changes` | The tool was called in a turn without an edit |
| 7.4 | Open the tool call result | The tool returns **empty** with the message **"nenhuma alteração gravada"** (e.g. `{"files": [], "message": "Nenhuma alteração gravada"}`) | No false positives — a turn without an edit lists no files |
| 7.5 | Check on disk: `git -C ~/orbit-teste-manual status --short` (if the folder is a repo) or compare the content | The tool's result matches the filesystem | The tool is deterministic (it tells the truth, not what the LLM "thought") |

### Scenario 8 — Footer A3: "Arquivos alterados neste turno" tells the truth

**Goal:** the deterministic footer (generated by the app from the filesystem snapshot, not by the LLM's text) lists the changed files with the number of diffs; turns without an edit show no footer.

| Step | Action | Expected result | Acceptance criterion |
|-------|------|--------------------|--------------------|
| 8.1 | (Turn with an edit) Send: `Crie o arquivo novo.txt com o texto "novo" e adicione a linha "EDIT" em ola.txt.` | Turn finishes with 2 changed files | — |
| 8.2 | Observe the assistant message's footer | The footer shows **"Arquivos alterados neste turno:"** listing `ola.txt (1 diff)` and `novo.txt (criado)` | Format: `Arquivos alterados neste turno: <file> (<n> diff)`; created/deleted files marked as `(criado)`/`(excluído)` |
| 8.3 | (The agent's text can lie — the footer cannot) Send: `Adicione a linha "MENTIRA" em ola.txt e termine dizendo: "Não alterei nenhum arquivo neste turno."` | The assistant's text claims nothing was changed, **but** the footer lists `ola.txt (1 diff)` | The footer reflects the filesystem snapshot, **regardless** of the LLM's text |
| 8.4 | Check on disk: `cat ola.txt` | The "MENTIRA" line exists | The footer is correct with respect to the disk |
| 8.5 | (Turn without an edit) Send: `Explique o que é um snapshot em sistemas de arquivos.` (a purely textual question) | Turn finishes with no file tool at all | — |
| 8.6 | Observe the assistant message | **No** "Arquivos alterados neste turno" footer is shown | A turn without an edit shows no footer |
| 8.7 | (Tracking failure) If applicable, repeat scenario 5 and observe the footer | The footer shows "As alterações deste turno não puderam ser rastreadas." | The tracking failure has a warning of its own (do not confuse it with an empty list) |

### Scenario 9 — `session_context` tool: "what was changed in the previous turn?"

**Goal:** the `session_context` tool answers with the **real** data of the previous turn (mode, permissionMode, timestamps, files, tool part errors) and the agent's answer is anchored in that data.

| Step | Action | Expected result | Acceptance criterion |
|-------|------|--------------------|--------------------|
| 9.1 | Create the test session (section 2) | Session in code mode | — |
| 9.2 | Run a turn **with an edit** (e.g. step 8.1) and note down: approximate time, changed files, mode and permission level selected in the input | Turn with changes in `ola.txt` and `novo.txt` | There is a previous turn with edits to consult |
| 9.3 | In the next turn, send: `O que foi alterado no turno anterior? Use session_context.` | The agent calls the `session_context` tool and answers | The tool was used (visible in the tool call card) |
| 9.4 | Check the agent's answer | Answer with the real data of the previous turn, including: **mode** (code), the **permissionMode** used, **timestamps** (start/end of the turn), **changed files** and **tool part errors** (if any) | The data match what actually happened |
| 9.5 | Validate the data against the disk/the footer | Files cited = the ones in the previous turn's footer (scenario 8) and in `git status`/`cat` | The tool is faithful to the real state — it does not "invent" the summary |
| 9.6 | (Previous turn **without** an edit) Send a textual question, then ask again what was changed | The tool answers indicating that **nothing** was changed in the previous turn | No inventing files in a turn without an edit |
| 9.7 | (With a tool error, if reproducible) Force a tool error (e.g. ask to read a nonexistent file) and consult `session_context` | The answer mentions the tool part's error | Tool part errors show up in the data |

---

## 5. How to report a failure

If any step fails, collect **before restarting/cleaning up** the environment:

### What to collect

1. **Scenario and step identification** — e.g. "Scenario 2, step 2.3".
2. **Action performed** — prompt sent, clicks made.
3. **Observed vs. expected result** — describe what appeared (or did not appear), with a screenshot if possible.
4. **Main process logs** — the terminal where `npm run desktop:dev` runs: capture snippets with `[snapshot]`, `error`, `revert`, `unrevert`, `[chat-engine]`.
5. **Renderer console** — in the app, `Cmd+Alt+I` (DevTools) → **Console** tab → copy errors/warnings.
6. **State on disk** (with the app closed):

```bash
# Find the app data folder:
find ~/Library/Application\ Support -maxdepth 4 -type d -name orbit-data 2>/dev/null
# Relevant structure:
#   <userData>/orbit-data/storage/session/<sessionId>.json   → revert state ("revert" block)
#   <userData>/orbit-data/storage/messages/<sessionId>.json  → messages ("snapshot"/"failed"/"parts"/"tokens")
#   <userData>/snapshots/<hash>/                             → auxiliary git repo of snapshots
```

7. **Versions and environment:**
   ```bash
   git rev-parse HEAD          # commit of the tested code
   node -v && npm -v
   sw_vers                     # macOS version
   ```
   + app version (bottom corner of the window or `apps/desktop/package.json`).

### Report template

```text
Scenario: C<X>, step <Y>
Command used: npm run desktop:dev (commit <hash>)
Action: <what I did>
Expected: <the step's acceptance criterion>
Observed: <what happened>
Logs: <paste the terminal / DevTools snippet>
State on disk: <session/<id>.json → "revert" block or messages/<id>.json → "snapshot">
Classification: [ ] regression  [ ] missing feature  [ ] intermittent failure
```

---

## 6. Final acceptance checklist

| # | Scenario | Passed? | Notes |
|---|---------|---------|-------------|
| C1 | Revert with a snapshot: file comes back + "1 arquivo revertido" | ☐ | |
| C2 | Revert without a snapshot: explicit warning (never silent) | ☐ | |
| C3 | Unrevert: files and messages come back | ☐ | |
| C4 | Close/reopen in the middle of the flow: state persists | ☐ | |
| C5 | Snapshot capture failure: `snapshot.failed` recorded | ☐ | |
| C6 | Nudge A1: forced continuation asking for `verify_changes` | ☐ | |
| C7 | `verify_changes`: with an edit → file+state+patchSize; without an edit → "no change written" | ☐ | |
| C8 | Footer A3: a turn with an edit shows files (n diff); without an edit it does not; the footer tells the truth | ☐ | |
| C9 | `session_context`: answer with the real data of the previous turn | ☐ | |

**Decision:** ☐ Approved for release · ☐ Approved with reservations (list them) · ☐ Rejected

---

## Annex A — Exact strings (pt-BR locale)

Source: `apps/desktop/src/i18n/locales/pt-BR.json`

| Key | Value |
|-------|-------|
| `chat.revert` | "Reverter até aqui" |
| `revert.filesRevertedOne` | "1 arquivo revertido" |
| `revert.filesRevertedNone` / `Many` | "Arquivos revertidos" / "{{n}} arquivos revertidos" |
| `revert.filesNotRestored` | "A conversa foi truncada, mas as alterações de arquivo NÃO puderam ser desfeitas (snapshot indisponível para esta mensagem)." |
| `revert.conversationReverted` | "Conversa revertida até este ponto" |
| `revert.continueFromHere` | "nova mensagem continua deste ponto" |
| `revert.unrevert` | "Desfazer" |
| `revert.diff` | "Diff" |
| `messageFooter.title` | "Arquivos alterados neste turno:" |
| `messageFooter.diffCount_one` / `other` | "{{count}} diff" / "{{count}} diffs" |
| `messageFooter.created` / `deleted` | "criado" / "excluído" |
| `messageFooter.failed` | "As alterações deste turno não puderam ser rastreadas." |

## Annex B — Code references (for debugging)

| Area | File |
|------|---------|
| Revert state (types) | `packages/shared/src/chat.ts` (lines ~28–52: `SessionRevert`, `filesRestored`, `reason`) |
| Revert/unrevert/cleanup logic | `apps/desktop/electron/lib/session/revert.ts` |
| Revert bar (UI) | `apps/desktop/src/components/revert-bar.tsx` |
| Changed-files footer (A3) | `apps/desktop/src/components/messages/message-footer.tsx` |
| "Reverter até aqui" action (UI) | `apps/desktop/src/components/messages/shared.tsx` (~line 417) |
| Snapshot capture (start/end of the turn) | `apps/desktop/electron/lib/chat-engine.ts` (~lines 484–491 and 599–611) |
| Snapshot engine (auxiliary git) | `apps/desktop/electron/lib/snapshot/index.ts` |
| IPC handlers | `apps/desktop/electron/main.ts` (~line 1019: `session:revert` / `session:unrevert`) |
| Storage on disk | `apps/desktop/electron/lib/storage.ts` |
