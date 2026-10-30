# Orchestra performance: where the hours and the gigabytes go

Measured on 2026-10-30, from the records of the orchestra run of 2026-10-29/30
(12 tasks, no worktrees, one folder) plus isolated benchmarks of the processes a
turn starts. This document exists because the same question came back twice —
"why is the orchestra so much slower than a chat?" and "why was the app using
26 GB?" — and both had been answered with impressions.

## How to measure next time

The app has instrumentation for exactly this, off by default:

```bash
ORBIT_PERF=1 npm run dev
```

It samples every 5 s and writes JSONL to
`<userData>/perf/perf-YYYY-MM-DD.jsonl` (`~/Library/Application Support/@orbit/desktop/orbit-data/perf/`
on macOS), with one line per sample and one per recorded span. Files older than
7 days are deleted when sampling starts. Each sample also carries
`heavyRunning`/`heavyWaiting` — the builds, tests and typechecks holding or
waiting for a slot (see below).

| span | opened at | what it answers |
|---|---|---|
| `plan` | `orchestrator.ts`, around `executePlan` | wall clock of a whole plan |
| `worker` | `runWorkerTurn` | duration/peak of each worker turn |
| `turn` | `chat-engine.ts`, `runChatTurn` | duration, steps, tools, peak — chat and worker alike |
| `review` | `orchestration/execution.ts` | how long the scheduler stayed blocked reviewing |
| `check` | `orchestration/checks.ts`, `runCheck` | each `npm run typecheck`/`test` the reviewer fires |
| `snapshot:capture` / `snapshot:diff` | `snapshot/index.ts` | git cost and queueing per folder |
| `index:scan` | `code-index/store.ts` | rebuilding the symbol index of a root |

Each sample carries the main process (`process.memoryUsage`), the Electron
helpers (`app.getAppMetrics`) and the CHILDREN of the app summed by `ps` — which
is where the gigabytes actually are. Quick look at the last hour:

```bash
tail -n 720 ~/Library/Application\ Support/@orbit/desktop/orbit-data/perf/perf-$(date +%F).jsonl \
  | jq -r 'select(.kind=="sample") | [.at, .mainRssMb, .appMb, .childrenMb, (.topChildren|join("; "))] | @tsv' \
  | sort -k4 -n | tail -5
```

Reproduce the cost of a wave of checks without the app:

```bash
node apps/desktop/scripts/tree-memory.mjs --parallel 1 -- npx tsc --noEmit
node apps/desktop/scripts/tree-memory.mjs --parallel 4 -- npx tsc --noEmit
```

## What the run of 2026-10-29 shows

Records: `storage/orchestration/jD_0t4yS8q0yioFBmWlrO.json` and the 12 worker
sessions it points at.

| metric | value |
|---|---|
| tasks / worker turns | 12 / 16 |
| wall clock, first turn → last | 6.8 h |
| sum of the worker turns | 474 min |
| **average concurrency** | **1.20 of the 4 slots (30 %)** |
| minutes with exactly one worker running | 285 of 409 |
| minutes with nothing running | 51 |
| tool calls | 2 002 |
| input tokens | 212.4 M (207.7 M read from cache, 97.8 %) |
| output tokens / cost | 1.13 M / $2.01 |
| turns ended with `terminated` | 3 (19.2 + 53.5 + 73.1 min = 2.4 h) |

The utilization is the whole story: with four slots and 474 minutes of work, a
perfect packer would have finished in ~2 h; it took 6.8 h. The slots idled
because tasks were created in waves by the orchestrator, because `dependsOn`
removed tasks from the queue, and because **the scheduler loop awaits each
review** — while a review is open, no queued task leaves the queue.

## Why it feels slower than a chat (it is not slower per step)

Comparing every turn in the history, workers against plain chat turns:

| | worker turn (n=78) | plain chat turn (n=683) |
|---|---|---|
| median duration | **10.2 min** | **1.3 min** |
| p90 | 36.0 min | 10.7 min |
| max | 73.1 min | — |
| median tool calls per turn | 108 | 21 |
| turns over 20 min | 32 % | 3 % |
| tool calls per minute of turn | 5.67 | 3.91 |

Per step the orchestra is not slower — it is 40 % faster, because a worker with
one huge task hits the prompt cache and repeats mechanical edits. What is
different is the unit: a worker runs a whole task (100–300 tool calls) inside
ONE turn, so nothing reaches the user for half an hour, and the review after it
runs in the same turn budget. A chat answers in ~1 minute and interleaves.

## Where the memory went

The app's own data is small; measured directly:

- one worker session on disk: 2.1 MB of JSON → **12 MB of V8 heap** after `JSON.parse`
  (4 ms). Twelve of them ≈ 150 MB, and the renderer keeps every session that is
  streaming (the 6-session cache never drops a busy one), at a few times that.
- snapshot patches: capped at 200 kB per turn.

The processes the turns start are not:

| command | peak of the whole tree | wall |
|---|---|---|
| `npx tsc --noEmit` (desktop) | **2.11 GB** | 25.5 s |
| `npm run typecheck` (root, all workspaces) | **2.08 GB** | 18.8 s |
| 2 × `npx tsc --noEmit` | 3.53 GB | 14.9 s |
| **4 × `npx tsc --noEmit`** | **5.99 GB** | 19.5 s |

In that night the 12 workers made **278 bash calls that ran a check**
(95 `tsc`, 139 `vitest`, 60 `eslint`, 11 other). With `MAX_PARALLEL = 4` and no
serialization of heavy commands, two to four compilers overlap regularly — 4–6 GB
of children alone, on top of Electron (~1.5–2 GB with 12 sessions and the panel
browser) and the embedding worker (~400 MB by design, see
`electron/memory-embed/worker.mjs`). On a 16 GB machine that is swap, and a
swapping main process freezes the UI and times out the model streams — which is
consistent with the three `terminated` turns, though the records do not prove
the link; the `turn` span now records the peak next to the error.

## What changed after this measurement

1. **Heavy commands share machine-wide slots** (`electron/lib/heavy-commands.ts`).
   The workers' `bash` and the reviewer's `runCheck` wait for a slot before
   starting a compiler, test runner, linter or build — one slot per 8 GB of RAM
   (2 on a 16 GB machine; `ORBIT_HEAVY_PARALLEL` overrides). The slot is held
   until the PROCESS exits, so a command promoted to the background still counts.
   A wave of four `tsc` now peaks at ~3.5 GB instead of ~6 GB. By the table
   above it takes ~30 s in two pairs instead of 19.5 s all at once — ten seconds
   against a machine in swap, which is what turned seconds into frozen minutes.
   Light commands (git, rg, ls, a node script) and watchers never wait. A worker
   that waited is told so in the tool output.
2. **The review runs beside the scheduler, not inside it**
   (`orchestration/execution.ts`). Reviews are still one at a time, but while one
   is open, a slot freed by another worker already takes the next queued task.
   This is what left 70 % of the slots idle.
3. **Workers are told to check narrowly** (`WORKER_PROMPT`): the changed test
   file while working, the full typecheck/test suite at most once at the end.
   278 full-check runs in one night was the input to item 1.
4. **The renderer drops the history of conversations nobody displayed.** A
   worker's chat streams into the renderer even when it is never opened, and the
   six-conversation cap only knew the ones that were displayed — so every worker
   kept its whole history (thousands of tool parts) until a reload. Now its
   buffer goes when its turn ends; opening it re-reads from disk.

## Still open

1. **Cap the size of a worker turn.** Workers do 100–300 tool calls in one turn
   with no checkpoint; a step budget that ends the turn and resumes it (the
   engine already supports continuations) would put the work of a long task on
   screen every few minutes instead of an hour later.
2. **Retry from the last step, not from scratch.** Each `terminated` restarted
   the whole task and recorded no tokens: 2.4 h of one night, invisible in the
   cost.
3. Run the project checks once at the integration review, not on every worker
   (item 3 above asks the workers; nothing enforces it).
