# Pipeline: integration branch, merge queue and delivery

Today, with `worktreePerTask` on, every pipeline task ends on its own branch (`pipeline/<slug>-<id>`) and the person has to look at them one by one and merge by hand. Nothing in the engine merges (the agents cannot run `git merge`), a task with several dependencies starts from the base and loses their work, and the board only grows.

This plan gives the pipeline **one integration branch and worktree**. Finished tasks commit and merge into it automatically, through a serial queue. The person reviews that one tree and, when happy, **delivers** it to a branch of their choice with one button, which archives the delivered tasks into a browsable history.

The pipeline is built for **minimum user interference**: the agents do the work, resolve conflicts and fix what breaks. The person validates at the end.

## Status

**Stages A, B, C, G, H and D are implemented** (E and F pending). Deviations from the draft: the merge-queue state lives in `Task.integration` (the task stays `completed`) instead of three new statuses, and a task that fails to integrate shows `integration.state = failed` with a Retry button instead of pause reason `integration`. The open decisions of the first draft are settled (see *Decisions*); a few new, smaller ones are at the bottom.

---

## Current state

| Piece | Where | How it is today |
|---|---|---|
| Task worktree | `electron/lib/pipeline/worktree.ts`, `engine.ts` (`ensureWorktree`) | Optional (`pipeline.worktreePerTask`). Branch `pipeline/<slug>-<id>`, from the base, or from the dependency's branch when it has exactly one. |
| Final commit | `engine.ts` (`generateCommitMessage`) | Optional (`commitAtEnd`). One-shot call on the **first phase's model**; commits only what the task changed. Push optional (`pushAtEnd`). |
| Queue | `engine.ts` (`advanceQueue`) | One *automatic* task at a time; tasks started by hand run in parallel. |
| Merge | — | None. Branches stay; the person merges. Dependencies with several branches start from the base. |
| Phase model | `runner.ts` | Per-phase provider/model, lean system prompt (`PRECEDENCE` + phase prompt), tools per phase. |
| Result screenshots | `pipeline.resultScreenshots`, `runner.ts` | A pipeline-wide switch: on, every phase gets the browser tools and the screenshots paragraph. |
| Chat tools | `electron/lib/tools/pipeline.ts` | `pipeline_create`, `pipeline_list`, `pipeline_create_task`, `pipeline_task_status`. |
| Orchestra | `electron/lib/orchestration/*` | Has what we reuse: `ownership.ts` (files per task), `checks.ts` (discover project checks), dependency merge in `createWorkerWorktree`, `mergeBranches`. |

---

## Decisions

1. **One model for the pipeline.** The model chosen when creating the pipeline is the **pipeline model** and the default of every phase; each phase can still override it individually, as today.
2. **The agent resolves, the person validates at the end.** Conflicts and failed checks are handled by the pipeline model with a bounded number of attempts (3). Only when it gives up does the task pause.
3. **Worktrees and commits are switches, both on by default.** With worktrees on (the flow this plan is about) every task has its own worktree and always merges into the pipeline's integration branch; with commits on, each task commits on its branch when it finishes. When the commit switch is off the pipeline creates no commits and shows the recommendation to commit per task (see *Worktree switch and simple mode*). There is no `pull` or `push` on its own. The only way work leaves the integration is the **Merge** button (pt-BR: **Mesclar**). With the switch off (or a folder without git) the pipeline runs in *simple mode*, as it does today. See *Worktree switch and simple mode*.
4. **Delivery history is kept**, with a delete option per delivery in a dropdown (it frees the stored images too). Nothing is deleted by default.
5. **A task can be returned at any time until it is delivered.** After delivery it is history: read-only.
6. **Delivery target is selectable**: any local branch, defaulting to the pipeline's base branch.
7. **Images are the agent's call, not a switch.** The user can delete an image from a task to free storage.

---

## Principles

- **The pipeline is not the orchestra.** The orchestra splits one big job and *must* join the pieces. Pipeline tasks are independent deliverables; the integration is a convenience, not a contract between tasks.
- **The integration branch is always clean.** Conflicts are resolved in the *task's* worktree, never in the integration.
- **The model is called only when there is something to decide.** A merge without conflict is plain git.
- **Anything that leaves the machine, or touches the person's own checkout, is the person's call** (Merge, any push).

---

## Stage A — Task ids, "open in chat", read/edit tools

Independent of everything else.

- Each pipeline gets a counter; each task gets a short number `#123` (`Task.number`), shown on the card and in the task dialog. Never reused, not even after archiving. The internal `id` stays; the number is a handle resolved by the tools.
- **Open in chat** (card and task dialog): opens a **new chat** in the task's worktree, with the message already typed and **not sent**: *"Analyze what was done in pipeline task #123"*. The person edits it and sends. The chat's own queue handles messages while something runs; the task knows nothing about it.
- New chat tools in `tools/pipeline.ts`:
  - `pipeline_task_read(number|id)` — title, description, status, notes per phase, rounds and returns, files, commit hashes, cost. **Summary + pagination**: notes truncated, the diff per file on request. Notes are unbounded today and would blow the chat's context.
  - `pipeline_task_edit(number|id, title?, description?)` — only while `pending` or `paused`. A running phase has already built its prompt and does not re-read the description.
- `pipeline_task_status` and `pipeline_list` accept the number.

## Stage B — Integration branch, always-on worktrees, serial merge queue

- The pipeline owns an **integration branch** `pipeline/<name>/integration` with its own worktree, created from the base on first use. It follows the "Worktrees folder" preference.
- **Settings**: `worktreePerTask` stays as a switch, now **on by default**; `commitAtEnd` stays as a switch, **on by default** too. `pushAtEnd` stops existing (see *Migration*): nothing is ever pushed. The commit-message prompt (`commitPrompt`) stays.
- Every task worktree is created **from the integration**, not from the base. This replaces `branchFromDependencies`: a task that depends on others already starts with their work in it, however many they are.
- **A dependency is satisfied when the task is `integrated`**, not merely `completed`.
- With `commitAtEnd` on (default) the final commit of the task is made on its branch when its last phase completes. With it off, see *Open decisions* 1.
- New task statuses: `awaiting_integration` (all phases done, final commit made), `integrating`, `integrated`. Pause reason `integration` (the model gave up, see C).
- **Serial queue, one per pipeline** (a promise chain, plus the persisted status so it survives a restart). The step for a task is **update-then-merge**:
  1. In the **task worktree**: `git merge <integration>` (brings in what other tasks delivered meanwhile).
  2. No conflict → continue. Conflict → stage C.
  3. Checks in the task worktree (stage C).
  4. In the **integration worktree**: `git merge --no-ff <task branch>`. Because the queue is serial and the task already contains the integration, this cannot conflict.
- The engine does these merges itself (agents still cannot run `git merge`).
- **Guards**: if the integration worktree has uncommitted changes in files the task changed, the queue waits and shows why (same idea as the orchestra's `blocked`). At boot, a task found `integrating` gets `git merge --abort` and goes back to `awaiting_integration`.
- The task's worktree is removed **once integrated** (disk). Its branch stays until delivery, so a return (below) can recreate the worktree from it.
- **Return (`returnTask`) at any time before delivery**: the worktree is recreated from the task's branch, the new round runs on top of it, and the task goes through the queue again (the update-then-merge step brings the current integration in first). Returning an integrated task does not undo what is already integrated; the new round adds to it.
- UI: the board shows the integration as one item (branch, commits ahead of the base, tasks in the queue). The worktree selector lists it first.

## Stage C — The pipeline model resolves conflicts and failed checks

- **Pipeline model** (provider + model): set when the pipeline is created, as today; it becomes the default of every phase unless a phase overrides it. New pipeline-level field, filled from that choice.
- It is called **only when needed**: a conflict in step 1 of the queue, or a failed check in step 3. It works in the task worktree with a restricted tool set: read/edit, and a command policy that allows only `git merge --continue/--abort`, `git add`, `git commit`, `git diff`, `git status` — nothing that touches another worktree, `push` or `pull`. `command-policy.ts` gets a profile for it.
- After resolving, the engine runs the project checks (`discoverChecks` from `orchestration/checks.ts`: typecheck/lint/tests that finish). A conflict that resolves textually but breaks the build is the real risk.
- A failed check is handed back to the model to **fix**, with the failing output, then the checks run again. **Bounded: 3 attempts** per integration (fixed, decided). Still failing (or the conflict unresolved) → the task **pauses** with reason `integration` and the model's note; the person opens it in chat (stage A) and decides. The integration is untouched either way.
- The pipeline model also writes the **final commit message** (replacing the first phase's model).

## Stage D — Parallel tasks in the queue

- Setting **parallel tasks** (1–4); available only with the worktree switch on. In simple mode it is 1.
- `advanceQueue` stops asking "is there any unfinished automatic task?" and asks "are there fewer than N active?". Dependencies still gate the start (`pendingDependencies`), and now also wait for `integrated`.
- Several tasks finishing together just line up in the merge queue.
- Checks and builds already wait in the machine-wide queue; no change there.
- Tasks that declare overlapping files (stage E) are serialized even with N > 1.

## Stage G — Merge into a branch, archive, history panel

- **Merge** button on the integration (decided name; pt-BR "Mesclar"; the label shows the destination, e.g. "Merge into `main`"), as a split button whose arrow picks the **destination branch** (any local branch; default the pipeline's base branch):
  0. **Pre-check (decided).** Before anything, it looks at the integration worktree. If it has uncommitted changes, nothing runs and a notice lists the files with two buttons: **Commit** (the pipeline model writes the message, the changes are committed on the integration, and the merge continues) or **Cancel**. It also checks that no task is `integrating` right now (it waits for the queue to drain) and that the destination exists.
  1. Brings the destination into the integration through the same queue (conflicts and checks → stage C). Also available alone as "Update with…".
  2. Fast-forwards the destination to the integration. If that branch is checked out in the person's checkout and has uncommitted changes in files involved, it waits and says which. If it is not checked out anywhere, the ref is moved without touching any working tree.
  3. Creates a **delivery** record: number, date, destination, merge hash, task numbers.
  4. **Archives** the delivered tasks and deletes their branches. The integration keeps going.
- No squash: each task keeps its own commit in `git log`.
- There is no push at all (decided). Sending the destination to a remote stays outside the pipeline.
- **Archived tasks leave the board but are not deleted.** They keep notes, cost, rounds, file list and commit hashes. The stored patch is **dropped on archive** — the diff is read from git by hash — so history does not bloat storage.
- Archived tasks are **read-only**. *Reopen* creates a **new** task linked to the original ("follow-up of #123") from the current integration. `pipeline_task_read` reads archived tasks too.
- **Side panel** (history): timeline by delivery → tasks inside → click a task for notes, files, diff, cost, images and *Open in chat*.
- **Deleting a delivery**: a dropdown on each delivery in the list. It removes the record, the archived tasks' notes and **their stored images**. Git history is untouched. Confirmation required; never automatic.

## Worktree switch and simple mode

Worktrees stay a switch because not every pipeline is about code, and not every folder has git. It is **on by default**; the flow is designed around it.

- **Switch on** (needs a git repository): everything in stages B to G.
- **Switch off**: *simple mode*, the behavior of today. Tasks run in the project folder, one at a time (a task started by hand can still run beside the queue, as now), nothing is merged. A finished task is `completed`; the button at the end is **Archive completed**, which moves them to the same history panel, with the diff coming from the task snapshots instead of git. Ids, open in chat, the read/edit tools, creating tasks by conversation, the suggestion card and images (A, E, F, H) work in both modes.
- **Messages** (pipeline dialog):
  - Switch on, git present: no message.
  - Switch off: *"Pipelines work much better with worktrees: tasks run in isolation, in parallel, and their work is merged for you. Without them, tasks run one at a time in your folder."*
  - Folder without git: the switch is off and disabled, with *"Pipelines were designed to work with git and worktrees. Without git, tasks run one at a time in your folder, and there is nothing to merge. Initialize git in this folder to get the full flow."* A one-click "Initialize git" (`git init`, with confirmation) can come later.
- **Commit switch** (`commitAtEnd`, on by default). When turned off, a small notice appears under it: *"Recommended: commit per task. Each task's work stays traceable and can be merged on its own; without commits, changes pile up in the working tree."* Off means **no commits are created** by the pipeline.
- Switching it **on** for a pipeline with tasks in progress applies to new tasks only; running ones finish where they are.

## Stage H — Images: the agent decides, the user can delete

- The `resultScreenshots` switch is removed (pipeline dialog and `pipeline_create` input). Migration: ignored.
- The screenshots paragraph (`runner.ts`) is injected only into **phases that already have the browser tools** (`allowed.has('browser')`), phrased as the agent's judgment: *if this task changed something visible, attach minimal evidence; if it did not, say nothing*. No new cost for phases without the browser. The default templates decide which phases have it (to check when implementing).
- Task dialog: each image in the description and in the notes gets a **delete** action. It removes the file from media storage and leaves a placeholder (`[image removed]`) where it was, so the text still reads.
- Archived tasks keep their images until the delivery is deleted (or the person deletes images individually in the history panel).

## Stage E — Talk to the pipeline model to create tasks

Two-step flow, like the routines:

1. **Describe** what is wanted, loosely.
2. The pipeline model returns **1 or N tasks** — title, full self-contained description, `dependsOn`, files each one will touch — shown in a modal. The person edits, removes or approves; nothing is created before that.

- Overlapping files imply a dependency, to reduce conflicts. Reuses `ownership.ts` and the cycle check (`createsCycle`) from the orchestra planner.
- Tasks are created `pending`; starting stays the person's call, as `pipeline_create_task` does today.
- The same planner can serve a chat tool, so "turn this into tasks" in a chat opens the same modal.

## Stage F — One suggestion card: here, subchat or pipeline

Today `suggest_subchat` (card in `ask-card.tsx`, pushed by a fixed system-prompt paragraph) and `pipeline_create_task` (only when asked) are separate.

- One card, three destinations: **here**, **subchat**, **pipeline** (the split button already has a menu for the alternative).
- One instruction replaces the two: subchat when it needs this conversation's context and reports back; pipeline for independent, larger work that deserves validation phases and its own worktree; several independent items → pipeline (one task each) or, if the person wants it now in this chat, the orchestra.
- The pipeline option appears only when a pipeline exists (`pipeline_list`), with a board picker if there is more than one. It opens the stage E modal.

---

## Migration

- Existing pipelines lose `pushAtEnd` (never pushed again); `commitAtEnd` keeps its value. Those already using `worktreePerTask` keep it on; those with it off stay in simple mode (they can turn it on). Tasks already running or paused **finish where they are** (their own folder or worktree). Pending tasks use the pipeline's current mode.
- Tasks already `completed` before the change have no integration: they stay on the board as completed until the person archives them (an "Archive" action), as a "legacy" delivery with no merge hash.
- Existing task branches `pipeline/<slug>-<id>` and the older `esteira/` ones keep working for read/return.
- `resultScreenshots` and `pushAtEnd` are dropped on the next write (`repo.ts` already tolerates unknown and legacy keys).

## Cost

| Stage | Extra | What controls it |
|---|---|---|
| A | zero | — |
| B | zero in tokens; a few `git` calls per task | — |
| C | one model call **per conflict**, plus up to 3 fix attempts and the checks | pipeline model; checks reuse the machine-wide queue |
| D | none by itself; parallel tasks multiply spend per minute | **Parallel tasks** |
| G | zero | — |
| H | slightly lower: the screenshots paragraph only in phases with the browser | — |
| E | one planning call per creation | — |
| F | zero (replaces an existing paragraph) | — |

## Implementation order

1. **A** — small, independent, useful on its own.
2. **B** — the core. Until C exists, a conflict pauses the task.
3. **C** — the model for conflicts, failed checks and the commit message.
4. **G** — deliver, archive, history panel (with delete and the branch selector).
5. **H** — images (small; can go anywhere after B).
6. **D** — parallelism (needs B; best after C, so conflicts are not all on the person).
7. **E**, then **F**.

Each stage with engine tests using real temporary git repositories (like `engine-worktree.test.ts` and `worktrees.test.ts`) and fake models for C and E.

## Open decisions

1. **Commit switch off while worktrees are on** (decided). A merge carries commits, so without a commit per task the task cannot be merged into the integration on its own. Proposal: with commits off, tasks run **one at a time in the integration worktree itself** (no per-task worktree, no parallel tasks, no merge queue); their changes accumulate uncommitted and the pre-check of **Merge** offers a single **Commit** for all of it. The main checkout stays untouched in both cases. The switch shows this consequence when turned off.

Decided in this round (see *Decisions*): the button is **Merge** / **Mesclar**; the pre-merge commit is automatic (message by the pipeline model, no editing); edits in the integration while the queue runs only make it wait when they touch a file the task also changed, and say which.
