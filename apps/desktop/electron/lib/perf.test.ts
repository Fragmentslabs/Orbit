import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData: string

vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getAppMetrics: () => [
      { pid: 100, type: 'Browser', memory: { workingSetSize: 300 * 1024 } },
      { pid: 101, type: 'Renderer', memory: { workingSetSize: 200 * 1024 } },
    ],
  },
}))

const { expiredPerfFiles, sampleOnce, sumChildren } = await import('./perf')

beforeEach(() => {
  userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-perf-')))
})
afterEach(() => fs.rmSync(userData, { recursive: true, force: true }))

/**
 * `appendFile` is fire-and-forget by design: poll for the record instead of betting on a
 * fixed delay — under a loaded suite 50 ms is not always enough, and the test failed on it.
 */
async function waitForPerfFile(maxMs = 5_000): Promise<string[]> {
  const dir = path.join(userData, 'perf')
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
      const ready = files.find((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().length > 0)
      if (ready) return files
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`perf record never landed in ${dir}`)
}

describe('sumChildren', () => {
  it('walks the whole tree and skips the processes the app already reported', () => {
    const rows = [
      { pid: 1, ppid: 0, rss: 50_000, command: 'electron' },
      // helper already counted by getAppMetrics
      { pid: 100, ppid: 1, rss: 300_000, command: 'Electron Helper (Renderer)' },
      { pid: 200, ppid: 1, rss: 400_000, command: 'bash -c npm run typecheck' },
      // grandchild: bash → npx → node
      { pid: 300, ppid: 200, rss: 1_900_000, command: 'node tsc' },
      // another tree entirely, must not enter
      { pid: 900, ppid: 800, rss: 5_000_000, command: 'unrelated' },
    ]
    const result = sumChildren(rows, 1, new Set([100]))
    expect(result.count).toBe(2)
    expect(result.totalKb).toBe(2_300_000)
    expect(result.top[0]).toEqual({ command: 'node tsc', rss: 1_900_000 })
  })
})

describe('sampleOnce', () => {
  it('adds main, Electron and children into one total, in MB', async () => {
    const sample = await sampleOnce({
      table: async () => [
        { pid: 1, ppid: 0, rss: 100_000, command: 'electron' },
        { pid: 100, ppid: 1, rss: 300_000, command: 'renderer helper' },
        { pid: 200, ppid: 1, rss: 1_024_000, command: 'node tsc --noEmit' },
      ],
      electron: async () => ({ totalKb: 300_000, pids: new Set([100]) }),
      rootPid: 1,
      memory: () =>
        ({ rss: 400 * 1024 * 1024, heapUsed: 100 * 1024 * 1024, heapTotal: 150 * 1024 * 1024, external: 20 * 1024 * 1024, arrayBuffers: 4 * 1024 * 1024 }) as NodeJS.MemoryUsage,
    })
    expect(sample.mainRssMb).toBe(400)
    expect(sample.appMb).toBe(293)
    expect(sample.childrenMb).toBe(1000)
    expect(sample.totalMb).toBe(Math.round((400 + 293 + 1000) * 10) / 10)
    expect(sample.children).toBe(1)
    expect(sample.topChildren[0]).toContain('tsc')
  })
})

describe('expiredPerfFiles', () => {
  it('drops only the perf files past the retention window', () => {
    const now = Date.parse('2026-10-30T12:00:00Z')
    const names = ['perf-2026-10-30.jsonl', 'perf-2026-10-23.jsonl', 'perf-2026-10-22.jsonl', 'perf-2026-01-01.jsonl', 'notes.txt']
    expect(expiredPerfFiles(names, now, 7)).toEqual(['perf-2026-10-22.jsonl', 'perf-2026-01-01.jsonl'])
  })
})

describe('perfSpan', () => {
  it('is a no-op while the flag is off — no file is written', async () => {
    const perf = await import('./perf')
    expect(perf.perfEnabled()).toBe(false)
    perf.perfSpan('turn', { sessionId: 's' }).end({ steps: 3 })
    perf.perfEvent('plan:start', { tasks: 2 })
    expect(fs.existsSync(path.join(userData, 'perf'))).toBe(false)
  })

  it('records a span with its duration, peak and fields when ORBIT_PERF=1', async () => {
    vi.resetModules()
    vi.stubEnv('ORBIT_PERF', '1')
    const perf = await import('./perf')
    expect(perf.perfEnabled()).toBe(true)

    const span = perf.perfSpan('worker', { title: 'Translate comments' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    span.end({ replyChars: 42 })
    // appendFile is fire-and-forget: poll for the record instead of betting on a fixed delay.
    const files = await waitForPerfFile()
    expect(files).toHaveLength(1)
    const lines = fs
      .readFileSync(path.join(userData, 'perf', files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const record = lines.find((line) => line.kind === 'span')
    expect(record).toMatchObject({ label: 'worker', title: 'Translate comments', replyChars: 42 })
    expect(record.durationMs).toBeGreaterThanOrEqual(15)
    vi.unstubAllEnvs()
  })
})
