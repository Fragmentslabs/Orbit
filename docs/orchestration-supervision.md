# Orchestration: the orchestrator follows the workers

Today the orchestrator plans, fires the workers in parallel, **waits for all of them to finish**, writes the synthesis and only then reviews (2 rounds, one action per round, reading the first 2,000 characters of each worker's text). To anyone watching, it "stands waiting" and shows up only at the end.

This plan makes the orchestrator **follow along**: review each worker as soon as it finishes, ask for adjustments while the others work, verify with evidence, respect dependencies between tasks and, optionally, isolate each worker in a worktree.

## Status

**Implemented (stages 0 to 6).** Open decisions settled by the proposals: Rigorous discovers the checks from the project, the cap of 4 simultaneous workers is fixed, and the phone only receives the new state (changing the options in the app is left for later).

Where it landed:
- `electron/lib/orchestration/execution.ts` — coordinator (queue, dependencies, cap of 4, review per worker, budget, integration). Tested with fake workers and reviewers.
- `electron/lib/orchestration/reviewer.ts` — the orchestrator as an agent with tools (`show_diff`, `run_check`, `accept`, `request_adjustment`, `mark_failed`, `create_worker`).
- `electron/lib/orchestration/checks.ts` — project checks (package.json scripts and Makefile targets; only the ones that finish).
- `electron/lib/orchestration/worktrees.ts` — worktree per worker, commit on accept (without the copied `.env`), merge in dependency order.
- `orchestrator.ts` — the old phase 2 and the post-synthesis review are gone; the synthesis receives the state, the notes and the merge result.
- Interface: Orchestration dialog (Behavior), progress card (stages, extras, activity and adjustments), plan card (dependencies), Loop disabled with Orchestration on, and the help without the Loop + Orchestration combinations.

Differences from the text below:
- An extra worker created during the review spends one adjustment of the global budget (it is a worker turn like any other). Cap of 12 tasks per plan, counting the extras.
- The integration review runs up to 2 passes; it stops when a pass asks for nothing.
- The plan card shows the dependencies; to remove one, uncheck the prerequisite task (the dependency goes with it).
- A reviewer that is down (model error) does not block the plan: the worker is accepted as is, with the note.

---

## Current state

| Piece | Where | How it is today |
|---|---|---|
| Routing | `electron/lib/send-dispatch.ts` | With orchestration on, **it turns Loop on by itself** (`loop: input.options.loop !== false`). |
| Execution | `electron/lib/orchestrator.ts` → `runOrchestration` | Phase 1 plans; phase 2 runs everything with `Promise.all`; phase 3 synthesizes; phase 4 reviews. |
| Review budget | `orchestrator.ts` (`ORCHESTRATION_REVIEW_ROUNDS = 2`) | With Loop on, it becomes the `maxIterations` of the Loop dialog — an invisible coupling. |
| Review decision | `orchestrator.ts`, phase 4 | `generateText` that returns **one** JSON per round: `done`, `message_worker`, `create_worker`, `create_test_worker`. |
| Progress card | `src/components/task-progress.tsx`, mounted in `chat-view.tsx` | Lists `plan.tasks`; it does not show the review nor workers created later. (The per-worker status started arriving as each one finishes.) |
| Configuration | `orchestration-config-dialog.tsx`, `provider-store.ts`, `WorkerConfigSnapshot` (`packages/shared/src/companion.ts`) | Only the conductor's and the workers' model. Synced with main and the phone. |

---

## Settings (Orchestrate mode dialog)

Three options. They live in `WorkerConfigSnapshot` (new field `orchestration`), which already goes to main and to the phone; the "+" can still open the dialog before a send.

| Option | Values | Default |
|---|---|---|
| **Behavior** | *Orchestrate only* · *Supervise* · *Rigorous* | *Supervise* |
| **Adjustments per worker** | 0–5 | 2 |
| **Isolate workers in worktrees** | on/off (only in a git repository) | off |

- *Orchestrate only*: splits, runs and synthesizes — with no review (the behavior from before phase 4 existed).
- *Supervise*: reviews each worker as it finishes, asks for adjustments, creates extra workers if something is missing, integration review at the end.
- *Rigorous*: *Supervise* + only accepts a worker's work after running the project checks (typecheck/tests/lint).
- **Adjustments per worker** is the budget: the global cap is `adjustments × number of workers`. It is the only option that weighs on cost (each adjustment is a worker turn).

```ts
// packages/shared/src/chat.ts
export interface OrchestrationSettings {
  behavior: 'orchestrate' | 'supervise' | 'rigorous'
  adjustmentsPerWorker: number
  worktrees: boolean
}
export interface WorkerConfigSnapshot {
  // ...current fields
  orchestration?: OrchestrationSettings
}
```

Defaults without a button: review each worker when it finishes; several actions per round; the card shows everything; dependencies decided by the orchestrator in the plan (the user approves the plan); diff limited always in the review; automatic cap of simultaneous workers (4, the rest in the queue).

---

## Stage 0 — Decouple Loop

- `send-dispatch.ts`: orchestration **no longer turns Loop on** (`loop: input.options.loop !== false` goes away; `loop` goes as `undefined`).
- `orchestrator.ts`: the budget comes only from `orchestration.adjustmentsPerWorker`; `ORCHESTRATION_REVIEW_ROUNDS` and the reading of `loopConfig` disappear.
- Code input (`code-input.tsx` and the `+`): with Orchestration on, the Loop toggle is disabled, with the hint "In orchestration, the orchestrator is the one who reviews — adjust it in Orchestration settings". Turning Orchestration on with Loop on turns Loop off (and vice versa, with a notice).
- Loop stays the same for regular chats.

## Stage 1 — Review each worker when it finishes

- Phase 2 stops being a blind `Promise.all`: each worker, when it finishes, enters a **review queue** of the orchestrator (serial — there is only one orchestrator, and decisions in parallel would contradict each other).
- A worker's review looks at its task, the result and the diff (stage 2) and decides: *accept*, *request adjustment* (a message to the same worker, which runs again), *create extra worker* or *mark failure*.
- The other workers keep running meanwhile. A worker with an adjustment goes back to the queue when it finishes again.
- The synthesis only starts when everyone is accepted (or out of budget) — and it is preceded by an **integration review** (does the whole meet the request?), which can generate more adjustments within the budget.
- *Orchestrate only* skips the reviews and goes straight to the synthesis.

## Stage 2 — Review with evidence (orchestrator with tools)

- The decision stops being a single JSON: the reviewer becomes an **agent with tools**, in a short loop:
  - `show_diff(worker)` — the worker's files and patch (limited, ~20 kB, with the names of all files);
  - `run_check(command)` — the project's read/verification commands (typecheck, tests, lint), with the pipeline's command policy. In *Rigorous* it is mandatory before accepting; in the other modes it is the second channel, for when the diff did not arrive or does not decide;
  - `request_adjustment(worker, instruction)`, `create_worker(title, prompt, dependsOn?)`, `accept(worker)`, `mark_failed(worker, reason)`.
- The diff comes from each worker's snapshot (the same mechanism as the per-turn diff). With workers in the same folder (no worktrees), the diff measures the whole folder — the review receives the notice that there may be changes from other workers; with worktrees (stage 6), it is exact.
- A turn whose snapshot capture fails leaves no patch at all, and that is **not** read as "wrote nothing": `show_diff` reports that the diff is unavailable (with the reason) and the current state of the folder comes in as second evidence. Only after that can the absence of a diff weigh on a decision.
- The worker's final text still comes in, but without the 2,000-character cut (a higher limit, with a summary if it goes over).

## Stage 3 — Several actions per round, budget per worker

- One review round can emit several actions (adjust A and C, create D).
- Each worker has its own adjustment counter (`task.revisions`, which already exists); the global cap protects against a plan of 10 workers with 5 adjustments each.
- With no budget for a worker, the review can only accept it or mark it as failed — and the synthesis says what was left pending.

## Stage 4 — Progress card shows the supervision

- Per-task states: *queued* · *running* · *under review* · *adjustment N* · *accepted* · *failed* (today: running/completed/error).
- Workers created during the review enter the list (with the "extra" badge).
- Orchestrator status line: "Reviewing: STT engines", "Asked for an adjustment on TTS (2/2)", "Integration review".
- Counter: accepted/total and adjustments used/cap.
- `OrchestrationTask.status` gets the new states; the card (`task-progress.tsx`) and the `TaskItem` follow along. Mobile shows the same states.

## Stage 5 — Dependencies between tasks

- The plan gets `dependsOn: string[]` per task (ids of other tasks). The planning prompt starts asking for it when order matters (e.g.: "integration tests" after "API" and "UI").
- A task only leaves the queue when its dependencies have been **accepted** — and it receives their summary in the prompt.
- The plan approval card shows the dependencies (and the user can remove them before approving).
- Cycles are refused at planning time (the same `createsCycle` as the pipeline).

## Stage 6 — Worktree per worker (optional)

- With the option on (and the folder in a git repository), each worker runs in its own worktree, created by the worktree core (`electron/lib/worktrees`), on a branch `orchestration/<session>/<task>`, from the current branch.
- Dependents start from the dependencies' branch (as the pipeline does with a single dependency; with several, the orchestrator merges them first).
- When everyone is accepted, the orchestrator **joins the branches** in the chat's worktree (or in the main one), in dependency order. Conflict: it tries to resolve it with an integration worker; failing that, it stops and shows the files in conflict.
- The workers' worktrees are removed at the end (branches kept until the merge). They respect the "Worktrees folder" preference.

---

## Cost

The workers dominate the cost of an orchestration; the orchestrator is small next to them.

| Stage | Extra | What it controls |
|---|---|---|
| 1 | low — one short review per worker | — |
| 2 | medium — the diff enters the context (limited); tests cost time, not tokens | *Rigorous* turns the checks on |
| 3 | the largest — each adjustment is a worker turn | **Adjustments per worker** |
| 4 | zero | — |
| 5 | neutral or lower — avoids rework from the wrong order | — |
| 6 | zero in tokens; ~16 s and disk per worker; risk of conflict in the merge | **Isolate in worktrees** |

---

## Implementation order

1. **Stage 0** (decouple Loop) + the `OrchestrationSettings` type and the dialog.
2. **Stages 1, 3 and 4** together — they change the feeling of "waiting" to "following along".
3. **Stage 2** — the biggest quality gain.
4. **Stage 5**.
5. **Stage 6**.

Each step with orchestrator tests using fake workers (mock of `runWorkerTurn` and of the model), like the pipeline's.

## Open decisions

1. *Rigorous*: which verification commands? Proposal: the orchestrator discovers them from the project (`package.json` scripts, `Makefile`), and the user can pin a list in the dialog later.
2. Cap of simultaneous workers: fixed at 4 or also configurable? Proposal: fixed for now, configurable if the need shows up.
3. Mobile: show and change the three options in the app from stage 0 on, or only show them?
