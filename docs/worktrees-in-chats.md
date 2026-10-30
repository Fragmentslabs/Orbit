# Worktrees in chats

Plan for code-mode chats to work in a `git worktree`, besides the main repository.

## Status

**Stages 0, 1 and 2 implemented.** Decisions: chat branches on `orbit/<name>`; worktrees created outside Orbit show up (removing asks for confirmation and warns); the Orbit repository itself has no special treatment.

Differences from the plan below:
- **No registry of its own** (`worktrees.json`): the origin of each worktree comes from the path (`orbit-data/worktrees/chats/…` = chat, `orbit-data/worktrees/<project>/…` = pipeline, outside that = external) and the state comes from git. "Ahead" counts commits the main branch does not have yet — it gives the same warning as "merged", without needing to know the base.
- **Deleting the chat** asks whether the worktree goes with it, as Claude Code does when leaving a worktree (default: keep). It only applies to a worktree created by a chat that no other chat uses. Removing the worktree loses the uncommitted changes; the commits are only lost if the branch is also deleted — and any loss requires confirmation.
- **Worktrees folder** (Preferences → code mode): Orbit data (default), inside the project (`.orbit/worktrees`, which Orbit puts in `.git/info/exclude` and the agent's searches ignore) or a chosen folder — refused if it is inside a repository, with a warning if it is on another disk than the home folder (dependencies linked instead of cloned). It applies to the pipeline too, and only to new worktrees. The origin of each worktree now comes from the branch (`orbit/` = chat, `pipeline/` = pipeline), which works in any folder.
- **"Updated remote" base** (Claude Code's *fresh*) in "New worktree…" and in the tool (`base: "@remote"`): starts from the `origin` default branch after a fetch, without taking unsent local commits. New branches are born without an upstream (`--no-track`), so a push does not end up on `main`.
- **Branch selector**: switching to a branch open in another worktree shows a notice of its own, instead of the uncommitted-changes dialog.
- **Recent folders**: no change — the list keeps the workspace folders, and going back to a chat in a worktree reopens the worktree, which is the right thing.

Code: `electron/lib/worktrees/` (core shared with the pipeline, `main.ts`, `service.ts`), `electron/lib/tools/worktrees.ts`, `src/components/worktree-selector.tsx`, `src/stores/worktree-store.ts`.

## Why (and for whom)

A worktree is a second working copy of the same repository, on its own branch, that shares the `.git`. In Orbit's day-to-day it solves three situations:

1. **Two chats on the same project at the same time.** Today both edit the same folder: one steps on the other, and the diff/revert of one shows the other's work.
2. **Disposable experiment.** "Try rewriting this another way" without dirtying the current branch. If it is no good, discard it; if it is good, merge it.
3. **Orbit working on its own code in dev mode.** Editing `electron/` restarts the app in the middle of a turn. In a worktree, the running app does not see the changes.

Whoever does not use a worktree should notice nothing: the feature stays hidden until the folder is a git repository, and the default remains the main repository.

## Recommendation

**Both forms, with the UI as the main one and the agent as a shortcut.**

- **UI (main):** a "Worktree" section in the folder selector, which already exists and is already where you choose "where this chat works". It lists the repository's worktrees and lets you switch, create and remove. It is the path for whoever does not remember git commands and for seeing the state of everything at once.
- **Agent (shortcut):** tools to list, create and switch, for phrases like "do this in a separate worktree" or "go back to the main one". Removing asks for confirmation, like any destructive action.

Agent only would be invisible (you would not know which folder the chat is in without asking). UI only would lose the "do this isolated" in the middle of the conversation, which is exactly when the idea comes up.

---

## Stage 0 — Shared base (prerequisite, fixes the pipeline)

### Logical project = main repository

Several points identify the project **by the folder path**. A worktree lives at another path, so today it would become a "new project":

| Point | Where | Effect without the fix |
|---|---|---|
| Project memory | `electron/lib/memory/service.ts` → `resolveProjectScope` / `projectIdOf` | No memories and no project map; new memories stuck to a path that disappears when the worktree is removed. **Already happens with the pipeline's worktree per task (`f3796376`).** |
| Sidebar folder | `session-store.ts` → `folderKey` / `normalizeFolderName` | The chat would land in a new sidebar folder, named after the worktree. |
| Recent folders | `folder-selector.tsx` (`orbit-recent-folders`) | Worktrees would pollute the recent list. |

**Fix:** a function `folderInMainRepository(folder)` that, for a folder inside a worktree, returns the equivalent folder in the main repository:

- `git rev-parse --git-common-dir` points to the main repository's `.git`; its parent is the main root.
- It preserves the subfolder: `<worktree>/apps/web` becomes `<main>/apps/web` (the `/init` in a monorepo depends on it).
- Result cached per folder (it is called on every turn).

Used in `resolveProjectScope`, in the sidebar grouping and in the recents. It fixes the pipeline for free.

> **Memory: done.** `electron/lib/worktrees/main.ts` (`folderInMainRepository`) is called at the entry of `resolveProjectScope`. Since every read and write of project memory goes through there (memory tools, prompt context, `/init`, the pipeline's final commit message), a worktree sees and feeds the main repository's memory. Sidebar and recents are left for stage 1, together with the selector — today only the pipeline creates worktrees, and tasks do not show up in the sidebar.

### Shared worktree service

Today the logic is in `electron/lib/pipeline/worktree.ts`. It becomes `electron/lib/worktrees/` and starts serving the pipeline and the chats:

- **Create:** new or existing branch, from a base, with `node_modules` cloned copy-on-write and `.env*` copied. It is what the pipeline already does, but with the branch name coming from outside.
- **List:** `git worktree list --porcelain` + an Orbit registry (`orbit-data/worktrees.json`) with the owner of each one (`chat:<sessionId>`, `pipeline:<taskId>` or none, for worktrees created outside Orbit). That way the worktrees the user created by hand also show up.
- **State:** uncommitted changes, commits ahead/behind the base, whether the branch has already been merged. It is what feeds the removal warnings.
- **Remove:** folder + registry + snapshots + background processes with `cwd` inside it. The branch stays, unless it is requested.
- **Orphans:** cleanup at boot, like the pipeline's, but guided by the registry.
- **Folders:** `orbit-data/worktrees/<repo-id>/<name>`. The pipeline's stay where they are.

---

## Stage 1 — Worktree selector in the chat

### Where it shows up

The folder selector already has two forms, and both get the same section:

- **Normal** (`FolderSelector`): a **Worktree** section in the dropdown, below the main folder.
- **Compact** (`CompactWorkspaceSelector`, narrow header): a third shortcut in the menu, next to "Branch" and "Folders": **Worktree ›**, showing the current one.

The selector button shows where the chat is:

```
📁 Orbit                    ← main repository (as today)
📁 Orbit · ⎇ chat-login     ← in a worktree (its branch)
```

### The section

```
Worktree
  ● Main                      homolog
  ○ chat-login                3 changes
  ○ new-layout-test           merged
  ○ pipeline/freight-a1b2c3   (pipeline)     ← read-only here
  ─────────────
  + New worktree…
```

- **Clicking** switches this chat's main folder to the worktree (the extra folders stay). Switching in the middle of a conversation is allowed: the next message already runs there, and the agent is told about the switch.
- **Each row:** branch, state ("3 changes", "2 commits ahead", "merged") and an `×` to remove (except the main one and the pipeline's, which the pipeline manages).
- **Remove:** a confirmation that says what is lost. "No changes and already merged" removes directly; with uncommitted changes, it warns and offers "Delete the branch too" (unchecked).
- **New worktree…:** a short dialog:
  - name (suggested from the chat title; becomes the `orbit/<name>` branch);
  - base (default: the main repository's current branch);
  - "Switch this chat to it" (checked).
  While it clones `node_modules`, the button shows "Preparing…" (~16 s in Orbit).

### Per chat, not global

The worktree belongs to the **session**, as the folders already do: two chats can be in different worktrees of the same repository. A new chat starts in the main one. In the future, there may be a "New chat in a worktree" option in the "+".

### Integrations that need to respect the worktree

| Point | What to do |
|---|---|
| Branch selector | In a worktree, show its branch; checking out a branch in use in another worktree fails in git: translate the error ("already open in worktree X"). |
| Diff, revert, snapshots | They already work per folder; removing the worktree deletes its snapshots. |
| Terminal and processes | `cwd` = worktree; on removal, terminate the processes running inside it. |
| Delete the chat | If the chat created the worktree: clean and merged, remove it along; with changes, ask. A worktree another chat also uses is never removed along. |
| Sidebar | The chat stays in the main repository folder, with a branch icon. |

---

## Stage 2 — Agent tools

- `worktree_list`: the worktrees of the chat's repository, with state.
- `worktree_create { name, base?, switch? }`: creates and, by default, switches the chat to it.
- `worktree_switch { name | "main" }`: switches the chat's main folder. The renderer updates the selector through the session event that already exists.
- `worktree_remove { name, deleteBranch? }`: always asks for approval, even in full-permission mode.

The code-mode prompt gets a line when the chat is in a worktree ("you are in worktree X, branch Y, created from Z; the main one belongs to other chats"), as the pipeline already does.

---

## Stage 3 — Closing the work

Reuses what stage 3 of the pipeline will build (`docs/pipeline-worktree-and-review.md`): **Merge**, **Create PR** and **Discard**, now also on the worktree row in the selector (`⋯` menu) and as agent tools ("merge this into homolog"). That is why the suggested order is to do stage 3 of the pipeline already on top of the shared service of stage 0.

---

## Stage 4 — Mobile

The app shows which worktree the chat is in (badge in the header) and lets you switch between the existing ones. Creating and removing stay on the desktop, or through the agent.

---

## Suggested order

1. **Stage 0**, with the memory fix first: it is a bug of the pipeline's worktree that is already on `homolog`.
2. Stage 3 of the pipeline (merge/PR/discard), already on the shared service.
3. Stage 1 (selector) and stage 2 (agent) of the chats.
4. Stage 4 (mobile).

## Open decisions

1. Prefix of the chat worktrees' branch: `orbit/<name>` (proposal) or no prefix?
2. Worktrees created outside Orbit show up in the list (proposal: yes, and they can be selected; removal only with an extra confirmation)?
3. In dev mode, suggest on your own "work in a worktree" when the chat is in Orbit's own folder (avoids the restart in the middle of a turn)?
