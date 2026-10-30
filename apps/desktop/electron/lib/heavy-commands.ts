import os from 'node:os'

/**
 * Machine-wide cap on the commands that cost gigabytes: compilers, test runners,
 * linters and production builds.
 *
 * Why: one `tsc --noEmit` on this monorepo peaks near 2 GB, and an orchestra with
 * four workers in one folder started one each — 4 × tsc measured 6 GB of children
 * on top of Electron, which on a 16 GB machine is swap, a frozen main process and
 * model streams that time out (docs/orchestra-performance.md). Running them in
 * parallel never made the wave faster either: they compete for the same cores and
 * the same disk, so four at once take about as long as two in a row.
 *
 * The cap is per MACHINE, not per folder: the memory it protects is the machine's.
 * Light commands (git, ls, rg, a single node script) never wait.
 */

const GB = 1024 ** 3

/** How many heavy commands may run at once: one per 8 GB of RAM, at least one. */
export function heavySlots(totalBytes = os.totalmem(), override = process.env.ORBIT_HEAVY_PARALLEL): number {
  const forced = Number(override)
  if (Number.isInteger(forced) && forced > 0) return forced
  return Math.max(1, Math.floor(totalBytes / (8 * GB)))
}

/** The tools whose process tree reaches gigabytes, called directly or through npx/pnpm dlx/bunx. */
const HEAVY_BINARIES = /(?:^|[\s;&|(/])(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|bunx\s+)?(?:tsc|vue-tsc|vitest|jest|eslint|biome\s+check|playwright\s+test|cypress\s+run|webpack|rollup|next\s+build|vite\s+build|electron-builder|tsup)\b/
/** Package scripts that by convention run one of the above. `dev`/`start`/`watch` are not here: they never end. */
const HEAVY_SCRIPTS = /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|tsc|test|tests|lint|build|check|verify)(?::[\w-]+)?\b/
/** Other ecosystems' compilers and test runners. */
const HEAVY_OTHERS = /(?:^|[\s;&|(])(?:cargo\s+(?:build|test|check|clippy)|go\s+(?:build|test|vet)|gradlew?\s|mvn\s|pytest\b|python3?\s+-m\s+pytest|swift\s+(?:build|test)|xcodebuild\b|dotnet\s+(?:build|test))/
/** Long-running modes: a watcher holds the slot forever, so it is never counted as heavy. */
const NEVER_ENDS = /(?:--watch\b|\bwatch\b|\s-w\b|\bdev\b|\bserve\b)/

export function isHeavyCommand(command: string): boolean {
  const flat = command.replace(/\s+/g, ' ')
  if (NEVER_ENDS.test(flat)) return false
  return HEAVY_BINARIES.test(flat) || HEAVY_SCRIPTS.test(flat) || HEAVY_OTHERS.test(flat)
}

export type Release = () => void

interface Waiter {
  grant: (release: Release) => void
}

let running = 0
const waiters: Waiter[] = []

function makeRelease(): Release {
  let released = false
  return () => {
    if (released) return
    released = true
    running--
    const next = waiters.shift()
    if (next) {
      running++
      next.grant(makeRelease())
    }
  }
}

/**
 * Waits for a heavy slot. Resolves with the function that frees it — call it when
 * the PROCESS exits, not when the tool returns (a command promoted to the
 * background still holds its memory). Rejects with the signal's reason when the
 * turn is aborted while waiting, and the place in the queue is given up.
 */
export function acquireHeavySlot(signal?: AbortSignal, slots = heavySlots()): Promise<Release> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  if (running < slots) {
    running++
    return Promise.resolve(makeRelease())
  }
  return new Promise<Release>((resolve, reject) => {
    const waiter: Waiter = {
      grant: (release) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(release)
      },
    }
    const onAbort = () => {
      const at = waiters.indexOf(waiter)
      if (at >= 0) waiters.splice(at, 1)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    waiters.push(waiter)
  })
}

/** For the tests and the perf samples: slots in use and commands waiting. */
export function heavyState(): { running: number; waiting: number } {
  return { running, waiting: waiters.length }
}
