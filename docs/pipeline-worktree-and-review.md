# Pipeline: review by rounds, worktree per task and delivery

Implementation plan in three stages, in this order:

1. **Send back with a comment** — review a completed task and send it back through the pipeline, with a per-round history.
2. **Worktree per task** — a pipeline option that isolates each task in a `git worktree` with its own branch.
3. **Delivery on completion** — with the worktree on, "Commit at the end" becomes "When the task completes": wait for review, create a PR or merge.

Stage 1 does not depend on the others and works with or without a worktree. Stages 2 and 3 go together: 3 only exists with 2 on.

---

## Current state (what already exists)

| Piece | Where | Observation |
|---|---|---|
| `Pipeline`, `Task`, `PhaseNote` types | `packages/shared/src/pipeline.ts` | `Pipeline.worktree?: string` exists (a fixed path for the whole pipeline), but nothing creates the worktree. |
| Task execution loop | `electron/lib/pipeline/engine.ts` → `runTask` | `root = pipeline.worktree \|\| project.folders[0]`. The initial snapshot (`capture`) and the task's accumulated diff come from that root. |
| Completion, final commit and push | `engine.ts` → `complete`, `tryCommit`, `generateCommitMessage`, `tryPush` | Commit and push are "delivery": a failure goes to `task.commitError`/`pushError` and does not pause the task. |
| Prompt of each phase | `electron/lib/pipeline/runner.ts` → `buildMessage` | The task description is the main brief; notes from previous phases come in as context. The text says "fixed order, without going back". |
| Phase directory | `runner.ts` → `syntheticSendInput` / `runPhase` | `directory: ctx.pipeline.worktree \|\| ctx.folders[0]`. |
| Parallelism | `Task.auto` | Tasks started manually **already run in parallel, in the same folder** — today one can step on the other. The worktree solves that. |
| Snapshots | `electron/lib/snapshot/index.ts` | Auxiliary repository per directory in `userData/snapshots/<hash>`. |
| UI | `src/components/pipeline/task-card.tsx`, `task-modal.tsx`, `pipeline-create-dialog.tsx` | Card, task modal and pipeline form. |

---

## Stage 1 — Send back with a comment (rounds)

> **Status: implemented.** Differences from the plan: the final commits of previous rounds stay in `Task.previousCommits` (the report and the footer still count all of them), and the modal shows "this phase did not run in this round" for the phases before `startPhase`. Tests in `electron/lib/pipeline/returns.test.ts` and `rounds.test.ts`.

### Flow

1. Task in **Completed** → **Send back** button on the card (and in the modal).
2. Dialog: comment field (required) + "Back from" (phase select, default: the first one).
3. The task goes back to `in_progress` at the chosen phase, with `round + 1`, and runs the pipeline again **on top of its own work** (same folder; with a worktree, the same worktree and branch).
4. On the card/modal, the history shows the rounds: `Round 1 → comment → Round 2 → …`. The most recent one open, the previous ones collapsed.

### Data (`packages/shared/src/pipeline.ts`)

Everything optional, so old tasks read as round 1:

```ts
export interface TaskReturn {
  /** Round that this return OPENS (the first return opens round 2) */
  round: number
  text: string
  /** Index of the phase the round restarts from */
  startPhase: number
  createdAt: string
}

export interface PhaseNote {
  // ...current fields
  /** Round in which the note was written (absent = 1) */
  round?: number
}

export interface Task {
  // ...current fields
  /** Current round (absent = 1) */
  round?: number
  returns?: TaskReturn[]
}
```

`notes` stays a single list; the UI groups it by `round`. Tokens, cost and time keep adding up on the task (the total of the whole task); the per-round summary is computed from the notes.

### Engine (`engine.ts`)

New `returnTask(pipelineId, taskId, text, startPhase = 0)`:

- Only accepts a task with `status === 'completed'` and `isTaskRunning(taskId) === false`.
- Writes: `round = (round ?? 1) + 1`, appends the `TaskReturn`, `status = 'in_progress'`, `currentPhase = startPhase`, clears `commitError`, `pushError`, `error`, `pauseReason`, `completedAt`; `auto = false` (a return is manual and does not enter the queue).
- Calls `executeTask` the way `startTask` does.
- `diff.start` **stays**: the task diff remains the accumulated one since the beginning (it is what matters for reviewing/merging). Optional: also keep the snapshot from the start of the round to show "what changed in this round".
- Skipped phases (`startPhase > 0`) do **not** generate a `skipped` note on a return — their work already exists from the previous round.
- Final commit: runs again at the end of each round (one commit per round). `generateCommitMessage` receives the return comment so the message describes the fix.

Dependents: if another task depends on this one and has already started/completed, warn in the dialog ("Tasks that depend on this one already ran with the previous version") — without blocking.

### Phase prompt (`runner.ts` → `buildMessage`)

When `round > 1`:

- Right after the task description, a priority section:
  ```
  ## Review feedback (round N)
  The user reviewed the previous round and sent it back with this feedback.
  It takes priority over the original description where they conflict.
  <return text>
  ```
- Notes: only the notes of the **current round** come in as "Notes from previous phases"; from the previous round comes a short summary (the note of the last phase of the previous round), plus the previous returns in one line each. Avoids resending the whole history every round (cost and noise).
- Adjust the "without going back" text: "this is round N; the repository already contains the previous round's work — fix it, do not redo it from scratch".

### IPC, store and UI

- IPC `pipeline:returnTask(pipelineId, taskId, text, startPhase)` in `main.ts`, `pipelineApi` (`src/lib/ipc.ts`) and `pipeline-store`.
- `task-card.tsx`: **Send back** button on completed tasks; `R2`, `R3`… badge when `round > 1`.
- `task-modal.tsx`: notes grouped by round, with the return comment between them.
- New `return-task-dialog.tsx`: textarea + phase select + dependent warning.
- i18n pt-BR/en.
- Companion/mobile: channel `pipeline:return` later (outside the initial scope).

### Tests

- `returnTask`: refuses a task that is not completed/running; increments the round; clears failures; keeps `diff.start`.
- `buildMessage`: feedback section present only with `round > 1`; notes filtered by the current round.
- Grouping by round with old notes that have no `round`.

### Resume with an instruction (paused task)

> **Status: implemented.** A complement to stage 1 for the middle of the way.

- A paused task (by error or by hand) gets **"Resume with an instruction"**: on the card (icon next to play), in the error banner and in the modal footer.
- The instruction stays in `Task.instructions` (`ResumeInstruction`: text, round, phase, date) and does **not** open a new round.
- `resumeTask(pipelineId, taskId, instruction?)`: optional parameter — without it, the behavior is the previous one (mobile and companion stay the same). With it, it only accepts a paused task.
- Prompt: the instructions for the phase that is about to run come in as priority; the ones given to other phases of the same round come in as context (they are usually project facts, like the test command).
- Modal: the instruction appears at the top of the phase it refers to, in the round it was given.
- Mobile: together with stage 3, like the rest.

---

## Stage 2 — Worktree per task

> **Status: implemented.** Differences from the plan:
> - If the project's main folder is a subfolder of the repository (monorepo), the worktree is of the whole repository and the task works in the same subfolder inside it (`TaskWorktree.folder`).
> - A task that depends on **exactly one** task with a worktree starts from its branch (the dependency's work has not been merged yet). With several, it starts from the base.
> - Removing a task, pipeline or project deletes the worktree (with whatever was not committed — the confirmation warns) and **keeps the branch**. The branch only goes away on the discard of stage 3.
> - Measured in Orbit itself: the APFS clone of `node_modules` (2.1 GB) takes ~16 s and takes no perceptible space. The card shows "Preparing the task's worktree…" meanwhile.
> - Tests: `worktree.test.ts` (real git in a temporary folder) and `engine-worktree.test.ts`.

### Pipeline option

- `Pipeline.worktreePerTask?: boolean` — switch in the form: **"Isolate each task in a worktree"**, with the hint: "Each task works on its own branch and its own copy; you can run several at the same time without one touching the other."
- `Pipeline.worktree` (fixed path) stays as legacy: read if it exists, no UI.

### Data

```ts
export interface TaskWorktree {
  path: string
  branch: string
  /** Branch it came from and goes back to on the merge/PR */
  base: string
  createdAt: string
}

export interface Task {
  // ...
  worktree?: TaskWorktree
}
```

### New module: `electron/lib/pipeline/worktree.ts`

- **Where:** `userData/orbit-data/worktrees/<projectId>/<taskId>`. Outside the project folder on purpose: it does not show up in the agent's searches, does not trigger watchers (Vite/dev server) and does not depend on `.gitignore`.
- **Create** (at the start of the task's first run, before the initial snapshot):
  - `base` = `pipeline.branch` or the current branch of the main repository.
  - `branch` = `pipeline/<title-slug>-<6 chars of the id>`.
  - `git -C <repo> worktree add -b <branch> <path> <base>`.
- **Dependencies (the real weight):**
  - Find the `node_modules` of the main repository (root + workspaces, without descending into another `node_modules`) and clone them at the same relative path:
    - macOS: `cp -c -R` (APFS clone — copy-on-write, almost instant and almost no space). If the destination is on another volume, it falls back to a symlink.
    - Linux: `cp -R --reflink=auto`; Windows: junction.
  - Also copy essential ignored files that the worktree does not bring: `.env*` by default (configurable in the pipeline later).
  - The phase prompt warns: "dependencies were cloned from the main checkout; if you change dependency manifests, run the install".
- **Remove:** `git worktree remove --force <path>` (+ `git branch -D` only on discard), delete the snapshot repository of that path, terminate background processes whose `cwd` is inside it.
- **Orphan cleanup** at boot (together with `reconcileExecutions`): `git worktree prune` and delete folders of tasks that no longer exist.

### Engine and runner

- `runTask`: `root = task.worktree?.path ?? pipeline.worktree ?? project.folders[0]`. Creates the worktree if `worktreePerTask` is on and the task does not have one yet.
- `runner.ts`: `directory` and "Working folders" now use the task root; the Repository section reports `Branch: <task branch> (isolated worktree; base: <base>)`.
- `removeTask`, `removePipeline`, `removeProject`: remove the tasks' worktrees.
- The worktree is **not** removed on completion: it stays until merge, merged PR or discard (stage 3) — otherwise the return of stage 1 would have nowhere to continue.

### Known risks

- Two tasks with a dev server on the same port: the second one starts on another port or fails; note in the prompt "prefer an alternative port if the default is busy".
- The project's extra folders (`folders[1..]`) stay shared — only the main one is isolated.
- A repository without commits or a folder that is not a git repo: the option is disabled in the form, with the reason.

### Tests

- `worktree.ts` with a temporary repository: create, branch name, removal, orphan prune.
- Finding `node_modules` in a monorepo (does not enter a nested `node_modules`).
- `runTask` uses the task root when there is a worktree.

---

## Stage 3 — When the task completes (with a worktree)

### Form

With the **worktree on**, the "Commit at the end" and "Push at the end" rows give way to a **"When the task completes"** select:

| Option | What it does |
|---|---|
| **Wait for review** (default) | Commit on the task branch and stop. The card shows Merge / Create PR / Discard, and you can send it back. |
| **Create PR** | Commit, push and open the PR. Later returns update the same PR (same branch). |
| **Merge** | Joins into the base branch directly. With a warning: it skips the review. Conflict → stops at "waiting for review". |

The commit prompt gear stays in both modes. With the **worktree off**, nothing changes (commit + push as today).

```ts
export type PipelineDelivery = 'review' | 'pr' | 'merge'
export interface Pipeline {
  // ...
  /** Only applies with worktreePerTask; the final commit is always on */
  delivery?: PipelineDelivery
}

export interface TaskDelivery {
  state: 'waiting' | 'pr' | 'merged' | 'discarded' | 'conflict'
  prUrl?: string
  error?: string
  updatedAt: string
}
export interface Task {
  // ...
  delivery?: TaskDelivery
}
```

### Actions

- **Merge** (`git` in the main repository):
  - If the main repository is on the base branch and clean → `git merge --no-ff <branch>` there.
  - If it is on the base but with changes → refuse with the reason (do not touch the user's work).
  - If the base is not checked out anywhere → `git merge-tree --write-tree` + `commit-tree` + `update-ref` (requires git ≥ 2.38; below that, refuse and suggest a PR).
  - Conflict → `delivery.state = 'conflict'` and the card offers **"Send back to resolve the conflict"**: opens a round (stage 1) with ready-made feedback asking to bring the base into the task branch and resolve it.
  - Success → remove the worktree and, optionally, the branch.
- **Create PR:** `git push -u origin <branch>`; with `gh` installed and authenticated, `gh pr create --base <base> --head <branch>` with the task title and a body built from the round notes. Without `gh`: push + open the GitHub compare page (`shell.openExternal`, URL derived from the remote). Stores `prUrl`.
  - Return of a task with a PR: at the end of the round, push to the same branch (the PR updates itself).
  - The worktree stays until the user discards or the PR is merged (optional check via `gh pr view --json state`).
- **Discard:** confirmation → remove worktree and branch, `state = 'discarded'`.

### UI

- Completed card: delivery state badge (Waiting for review / PR open / Merged / Conflict / Discarded) and buttons according to the state.
- PR: "Open PR" link.
- Modal: the same area, with the full error when there is one.

### Tests

- Merge in the three scenarios (base checked out clean, base with changes, base not checked out) and conflict.
- Building the PR body; fallback without `gh`.
- Form: with a worktree, forced commit and hidden push; without a worktree, current behavior.

---

## Decisions

1. When merging, the task branch is deleted.
2. Sending back an already merged task is allowed, with a warning (creates a new worktree from the base).
3. Only `.env*` is copied to the worktree besides `node_modules`.
4. Send back and the delivery actions reach mobile (companion) together with stage 3.
