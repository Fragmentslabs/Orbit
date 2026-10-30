import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The per-folder queue of the snapshot engine.
 *
 * The auxiliary repository is PER FOLDER (gitDirFor), so workers running in
 * parallel in the same folder — the orchestra default, when there is no
 * worktree — hit the same `.git/index` and fight over the `index.lock`; whoever
 * loses writes no snapshot at all and the turn ends 'unknown' (no badge in the
 * chat and no diff for the reviewer).
 *
 * What is tested here is not git: `execFile` is doubled to measure how many
 * processes would be alive at the same time. With the queue, it is one per folder;
 * without it, there would be 2+ and the test breaks.
 */
const state = vi.hoisted(() => ({
  inFlight: 0,
  peak: 0,
  failOnce: false,
  userData: '',
}))

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (error: Error | null, output?: { stdout: string; stderr: string }) => void,
  ) => {
    state.inFlight += 1
    state.peak = Math.max(state.peak, state.inFlight)
    const failure = state.failOnce
    state.failOnce = false
    setTimeout(() => {
      state.inFlight -= 1
      if (failure) cb(new Error('fatal: Unable to create index.lock: File exists.'))
      else cb(null, { stdout: '', stderr: '' })
    }, 25)
  },
}))

vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))

const { capture, snapshotGit } = await import('./index')

describe('snapshot queue per folder', () => {
  let tmp: string
  let folderA: string
  let folderB: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-queue-')))
    folderA = path.join(tmp, 'project-a')
    folderB = path.join(tmp, 'project-b')
    fs.mkdirSync(folderA)
    fs.mkdirSync(folderB)
    state.userData = path.join(tmp, 'userData')
    state.inFlight = 0
    state.peak = 0
    state.failOnce = false
  })

  afterEach(async () => {
    // The gc of the capture enters the queue as fire-and-forget: without this wait it
    // would still be alive when the temporary directory was deleted.
    await new Promise((resolve) => setTimeout(resolve, 100))
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('does not interleave operations of the same folder', async () => {
    // Three turns of the same folder at the same time: one at a time.
    await Promise.all([capture(folderA), capture(folderA), capture(folderA)])
    expect(state.peak).toBe(1)
  })

  it('the gc enters the queue and does not run in the middle of a capture', async () => {
    await Promise.all([capture(folderA), snapshotGit(folderA, ['gc', '--quiet', '--prune=7.days'])])
    expect(state.peak).toBe(1)
  })

  it('different folders go on in parallel', async () => {
    // The queue is per folder, not global: one project does not wait for the other.
    await Promise.all([capture(folderA), capture(folderB)])
    expect(state.peak).toBe(2)
  })

  it('a capture that fails with index.lock does not sour the folder queue', async () => {
    state.failOnce = true
    await expect(capture(folderA)).rejects.toThrow(/index\.lock/)
    // The next operation of the same folder runs normally (the tail swallows the error).
    await expect(capture(folderA)).resolves.toBe('')
    expect(state.peak).toBe(1)
  })
})
