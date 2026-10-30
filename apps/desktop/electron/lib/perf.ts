import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Runtime performance instrumentation for long agent runs (orchestra, loops, big
 * chats).
 *
 * Why it exists: a 12-worker orchestra night ended with the app frozen and the
 * system reporting tens of GB of memory, and nothing on disk said where it went.
 * The app's own data is small — one worker session is ~2 MB of JSON, ~12 MB of
 * heap — so the peak had to be somewhere the turn does not keep: the processes a
 * check starts (`npx tsc` alone is ~2 GB) and the ones the app keeps alive for
 * every session. Without measuring, that was an opinion.
 *
 * OFF BY DEFAULT, zero cost when off. `ORBIT_PERF=1` turns it on; it samples
 * every `PERF_INTERVAL_MS` and writes JSONL to `<userData>/perf/perf-<date>.jsonl`,
 * plus a one-line console summary per recorded span.
 *
 * What a sample carries:
 *  - the MAIN process (`process.memoryUsage()`: rss, heapUsed, heapTotal,
 *    external, arrayBuffers);
 *  - every Electron process `app.getAppMetrics()` knows (renderer, GPU, utility);
 *  - the CHILDREN of the main process (bash → npx tsc/vitest/eslint), summed and
 *    with the top ones named, because they are the ones that reach gigabytes and
 *    they never show up in the app's own numbers. The Electron helpers reported
 *    by `getAppMetrics()` are excluded from that sum so nothing is counted twice.
 *
 * A span is a window (a turn, a worker, a review, a check): it records its
 * duration, the peak RSS observed while it was open and the fields the caller
 * passes. The peak is what matters — memory in a long turn is a spike, not an
 * average.
 */

const MB = 1024 * 1024

/** Sampling period. Long enough to be invisible, short enough to catch a 25 s `tsc`. */
export const PERF_INTERVAL_MS = 5_000

export interface MemoryTotals {
  /** Main process RSS, MB. */
  mainRssMb: number
  /** Electron processes from getAppMetrics (renderer, GPU, utility), MB. */
  appMb: number
  /** Child processes of the main (tsc, vitest, eslint…), MB. */
  childrenMb: number
  /** mainRss + app + children, MB. */
  totalMb: number
  /** Number of child processes alive. */
  children: number
}

export interface PerfSample extends MemoryTotals {
  at: number
  mainHeapMb: number
  mainHeapTotalMb: number
  mainExternalMb: number
  mainArrayBuffersMb: number
  /** Heaviest children: "npx tsc --noEmit 1987MB". */
  topChildren: string[]
}

interface SpanState {
  label: string
  startedAt: number
  fields: Record<string, unknown>
  baseline: PerfSample | null
  peak: PerfSample | null
  ended?: boolean
}

const enabled = process.env.ORBIT_PERF === '1' || process.env.ORBIT_PERF === 'true'

let samplingTimer: NodeJS.Timeout | null = null
let logFile: string | null = null
let logDirReady = false
/** Last sample — the baseline a span opened now would use, and the current state. */
let last: PerfSample | null = null
/** Open spans, so a sample can update their peak without scanning anything. */
const openSpans = new Set<SpanState>()

const round = (n: number) => Math.round(n * 10) / 10
const mb = (bytes: number) => bytes / MB

export function perfEnabled(): boolean {
  return enabled
}

/** Where the samples are going (null until the first write). */
export function perfLogPath(): string | null {
  return logFile
}

/** Pure: sum of the children's RSS, minus the pids the app already reported. */
export function sumChildren(
  rows: Array<{ pid: number; ppid: number; rss: number; command?: string }>,
  rootPid: number,
  exclude: Set<number>,
): { totalKb: number; count: number; top: Array<{ command: string; rss: number }> } {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const inTree = new Set<number>([rootPid])
  // Children of children (bash → npx → node → workers): closure over the tree.
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (inTree.has(row.ppid) && !inTree.has(row.pid)) {
        inTree.add(row.pid)
        changed = true
      }
    }
  }
  let totalKb = 0
  let count = 0
  const top: Array<{ command: string; rss: number }> = []
  for (const pid of inTree) {
    if (pid === rootPid || exclude.has(pid)) continue
    const row = byPid.get(pid)
    if (!row) continue
    totalKb += row.rss
    count += 1
    top.push({ command: row.command ?? `pid ${pid}`, rss: row.rss })
  }
  top.sort((a, b) => b.rss - a.rss)
  return { totalKb, count, top: top.slice(0, 5) }
}

/** The process tree of the app, as `ps` reports it (pid, ppid, rss in KB, command). */
async function processTable(): Promise<Array<{ pid: number; ppid: number; rss: number; command: string }>> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,args='], { maxBuffer: 8 * MB })
    const rows: Array<{ pid: number; ppid: number; rss: number; command: string }> = []
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (!match) continue
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rss: Number(match[3]),
        command: match[4]?.trim() ?? '',
      })
    }
    return rows
  } catch {
    return []
  }
}

/**
 * Electron's own processes. `app` is imported lazily: the sampler only runs in
 * the main process, and keeping the module importable from a test (no Electron)
 * is worth the one line.
 */
async function electronProcesses(): Promise<{ totalKb: number; pids: Set<number> }> {
  try {
    const { app } = await import('electron')
    const metrics = app.getAppMetrics?.() ?? []
    let totalKb = 0
    const pids = new Set<number>()
    for (const metric of metrics) {
      if (!metric?.pid) continue
      pids.add(metric.pid)
      const memory = (metric as unknown as { memory?: { workingSetSize?: number; rss?: number } }).memory
      // workingSetSize comes in KB; `rss` is the old field of the same unit.
      totalKb += memory?.workingSetSize ?? memory?.rss ?? 0
    }
    return { totalKb, pids }
  } catch {
    return { totalKb: 0, pids: new Set() }
  }
}

/** One reading now. Exported for the tests (with the readers swapped). */
export async function sampleOnce(readers?: {
  table?: () => Promise<Array<{ pid: number; ppid: number; rss: number; command: string }>>
  electron?: () => Promise<{ totalKb: number; pids: Set<number> }>
  memory?: () => NodeJS.MemoryUsage
  /** Root of the child tree. Defaults to this process (the Electron main). */
  rootPid?: number
}): Promise<PerfSample> {
  const [table, electron] = await Promise.all([
    (readers?.table ?? processTable)(),
    (readers?.electron ?? electronProcesses)(),
  ])
  const mem = (readers?.memory ?? (() => process.memoryUsage()))()
  const children = sumChildren(table, readers?.rootPid ?? process.pid, electron.pids)
  return {
    at: Date.now(),
    mainRssMb: round(mb(mem.rss)),
    mainHeapMb: round(mb(mem.heapUsed)),
    mainHeapTotalMb: round(mb(mem.heapTotal)),
    mainExternalMb: round(mb(mem.external)),
    mainArrayBuffersMb: round(mb(mem.arrayBuffers ?? 0)),
    appMb: round(electron.totalKb / 1024),
    childrenMb: round(children.totalKb / 1024),
    children: children.count,
    totalMb: round(mb(mem.rss) + electron.totalKb / 1024 + children.totalKb / 1024),
    topChildren: children.top
      .filter((c) => c.rss / 1024 >= 200)
      .map((c) => `${c.command.slice(0, 90)} ${Math.round(c.rss / 1024)}MB`),
  }
}

async function appendLine(entry: Record<string, unknown>): Promise<void> {
  if (!logFile) {
    try {
      const { app } = await import('electron')
      const base = path.join(app.getPath('userData'), 'perf')
      if (!logDirReady) {
        await fs.mkdir(base, { recursive: true })
        logDirReady = true
      }
      const day = new Date().toISOString().slice(0, 10)
      logFile = path.join(base, `perf-${day}.jsonl`)
    } catch {
      return
    }
  }
  try {
    await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // Instrumentation never breaks the app it measures.
  }
}

/** Starts sampling. Idempotent; does nothing when the flag is off. */
export function startPerf(intervalMs = PERF_INTERVAL_MS): void {
  if (!enabled || samplingTimer) return
  const tick = async () => {
    const sample = await sampleOnce()
    last = sample
    for (const span of openSpans) {
      if (!span.baseline) span.baseline = sample
      if (!span.peak || sample.totalMb > span.peak.totalMb) span.peak = sample
    }
    await appendLine({ kind: 'sample', ...sample })
  }
  void tick()
  samplingTimer = setInterval(() => void tick(), intervalMs)
  samplingTimer.unref?.()
  console.log(`[perf] sampling every ${intervalMs}ms`)
}

export function stopPerf(): void {
  if (samplingTimer) clearInterval(samplingTimer)
  samplingTimer = null
}

export interface PerfSpan {
  /** Closes the span. Extra fields are merged into the record. */
  end(extra?: Record<string, unknown>): void
}

const NOOP_SPAN: PerfSpan = { end() {} }

/**
 * Opens a span. When the instrumentation is off it returns a no-op object, so
 * the call sites stay one line and cost nothing.
 */
export function perfSpan(label: string, fields: Record<string, unknown> = {}): PerfSpan {
  if (!enabled) return NOOP_SPAN
  const span: SpanState = { label, startedAt: Date.now(), fields, baseline: last, peak: null }
  openSpans.add(span)
  return {
    end(extra?: Record<string, unknown>) {
      if (span.ended) return
      span.ended = true
      openSpans.delete(span)
      const durationMs = Date.now() - span.startedAt
      const peak = span.peak ?? last
      const record = {
        kind: 'span',
        label,
        durationMs,
        ...span.fields,
        ...(extra ?? {}),
        peakTotalMb: peak?.totalMb,
        peakMainMb: peak?.mainRssMb,
        peakChildrenMb: peak?.childrenMb,
        peakChildren: peak?.topChildren ?? [],
        baselineTotalMb: span.baseline?.totalMb,
      }
      console.log(
        `[perf] ${label} ${Math.round(durationMs / 1000)}s` +
          (peak ? ` · pico ${peak.totalMb}MB (app ${peak.mainRssMb} + electron ${peak.appMb} + filhos ${peak.childrenMb})` : '') +
          (peak && peak.topChildren.length > 0 ? ` · ${peak.topChildren.join(', ')}` : '') +
          ` · ${JSON.stringify({ ...span.fields, ...(extra ?? {}) }).slice(0, 200)}`,
      )
      void appendLine(record)
    },
  }
}

/** One-off record, for events that are not a window (plan start, scheduler step). */
export function perfEvent(name: string, fields: Record<string, unknown> = {}): void {
  if (!enabled) return
  const record = { kind: 'event', name, at: Date.now(), ...fields, currentTotalMb: last?.totalMb }
  console.log(`[perf] event ${name} ${JSON.stringify(fields).slice(0, 300)}`)
  void appendLine(record)
}
