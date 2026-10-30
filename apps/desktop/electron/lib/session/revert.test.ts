import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'

/**
 * Revert per message, end to end: messages + S/E/C per path.
 *
 * The scenarios that matter are the CONCURRENCY ones: two conversations in the same
 * folder, a file touched from outside after the turn, and what changes between the revert
 * and the unrevert. The revert cannot be a "restore of the whole folder".
 */
const userData = path.join(os.tmpdir(), `orbit-revert-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const { capture } = await import('../snapshot')
const { writeJson } = await import('../storage')
const { revert, unrevert } = await import('./revert')
const { withWorkspaceLock } = await import('./workspace-lock')

let counter = 0
let roots: string[] = []

async function setup(options: {
  /** Initial state of the files (before the turn). */
  initial: Record<string, string>
  /** What the turn did. */
  turn: Record<string, string | null>
  verified?: 'changed' | 'unchanged'
  /** Paths the turn changed but which are manual saves from the panel. */
  manual?: string[]
  /** Captures `end` even on an 'unchanged' turn (folder changed only by a manual save). */
  captureEnd?: boolean
}): Promise<{ dir: string; sessionId: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-revert-proj-'))
  roots.push(dir)
  for (const [rel, content] of Object.entries(options.initial)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), content, 'utf8')
  }
  const start = await capture(dir)
  for (const [rel, content] of Object.entries(options.turn)) {
    const abs = path.join(dir, rel)
    if (content === null) await fs.rm(abs, { force: true })
    else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf8')
    }
  }
  const verified = options.verified ?? 'changed'
  const end = verified === 'changed' || options.captureEnd ? await capture(dir) : undefined

  const sessionId = `s-revert-${process.pid}-${counter++}`
  const session: SessionInfo = {
    id: sessionId,
    title: 'Revert',
    mode: 'code',
    pinned: false,
    archived: false,
    folderId: null,
    directory: dir,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const user: ChatMessage = {
    id: 'u1',
    role: 'user',
    parts: [{ id: 'p1', type: 'text', text: 'mude', state: 'done' }],
    createdAt: Date.now(),
  }
  const assistant: ChatMessage = {
    id: 'a1',
    role: 'assistant',
    parts: [],
    createdAt: Date.now(),
    snapshot: {
      start,
      end,
      verified,
      manual: options.manual,
    },
  }
  await writeJson(StorageKeys.session(sessionId), session)
  await writeJson(StorageKeys.messages(sessionId), [user, assistant])
  return { dir, sessionId }
}

function read(dir: string, rel: string): Promise<string> {
  return fs.readFile(path.join(dir, rel), 'utf8')
}

function exists(dir: string, rel: string): Promise<boolean> {
  return fs.lstat(path.join(dir, rel)).then(
    () => true,
    () => false,
  )
}

afterEach(async () => {
  // the gc of the captures is fire-and-forget in the snapshots.
  await new Promise((resolve) => setTimeout(resolve, 80))
})

afterAll(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(userData, { recursive: true, force: true })
  roots = []
})

describe('file revert (S/E/C)', () => {
  it('undoes only the turn paths, without touching the rest of the folder', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'before', 'intocado.txt': 'stays' },
      turn: { 'a.txt': 'turno', 'new.txt': 'created' },
    })

    const state = await revert(sessionId, 'u1')

    expect(state?.filesRestored).toBe(true)
    expect(state?.files?.sort()).toEqual(['a.txt', 'new.txt'])
    expect(state?.conflicts).toEqual([])
    expect(await read(dir, 'a.txt')).toBe('before')
    expect(await exists(dir, 'new.txt')).toBe(false)
    expect(await read(dir, 'intocado.txt')).toBe('stays')
  })

  it('two conversations in the same folder: what the other changed after the turn stays', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'before' },
      turn: { 'a.txt': 'turno' },
    })
    // Another conversation in the SAME project writes after the final snapshot.
    await fs.writeFile(path.join(dir, 'a.txt'), 'another conversation', 'utf8')

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual([])
    expect(state?.conflicts).toEqual(['a.txt'])
    expect(await read(dir, 'a.txt')).toBe('another conversation')
  })

  it('a read-only turn does not reset the folder', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'stable' },
      turn: {},
      verified: 'unchanged',
    })
    const state = await revert(sessionId, 'u1')
    expect(state?.filesRestored).toBe(true)
    expect(state?.files).toBeUndefined()
    expect(await read(dir, 'a.txt')).toBe('stable')
  })

  it('a manual panel save during the turn is preserved and reported', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'before', 'manual.txt': 'before' },
      turn: { 'a.txt': 'turno', 'manual.txt': 'saved by hand' },
      manual: ['manual.txt'],
    })

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual(['a.txt'])
    expect(state?.conflicts).toEqual(['manual.txt'])
    expect(await read(dir, 'a.txt')).toBe('before')
    expect(await read(dir, 'manual.txt')).toBe('saved by hand')
  })

  it('a turn with only a manual save (unchanged + end): preserves the save and reports', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'before' },
      turn: { 'a.txt': 'saved by hand' },
      verified: 'unchanged',
      captureEnd: true,
      manual: ['a.txt'],
    })

    const state = await revert(sessionId, 'u1')

    expect(state?.filesRestored).toBe(true)
    expect(state?.files).toEqual([])
    expect(state?.conflicts).toEqual(['a.txt'])
    expect(await read(dir, 'a.txt')).toBe('saved by hand')
  })

  it('revert waits for another operation locked on the same folder (another revert)', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'before' },
      turn: { 'a.txt': 'turno' },
    })
    // Simulates another revert of the same folder in progress: this one has to wait.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const turn = withWorkspaceLock(dir, async () => {
      entered()
      await gate
    })
    await started
    const pending = revert(sessionId, 'u1')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await read(dir, 'a.txt')).toBe('turno')

    release()
    await turn
    await pending
    expect(await read(dir, 'a.txt')).toBe('before')
  })
})

describe('revert with the current-state capture failing', () => {
  it('touches no file at all and reports capture-failed', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'before' },
      turn: { 'a.txt': 'turno', 'new.txt': 'created' },
    })
    // An orphan index.lock in the auxiliary repository makes the `add --all` of the
    // capture fail — the same thing a crash in the middle of another capture leaves behind.
    const hash = crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 16)
    const lock = path.join(userData, 'snapshots', hash, 'index.lock')
    await fs.writeFile(lock, '')
    try {
      const state = await revert(sessionId, 'u1')

      expect(state?.filesRestored).toBe(false)
      expect(state?.reason).toBe('capture-failed')
      // Without the previous state, undoing would leave the files with no way back.
      expect(await read(dir, 'a.txt')).toBe('turno')
      expect(await read(dir, 'new.txt')).toBe('created')
      // The messages stay truncated and the unrevert gives them back.
      expect(state?.discardedMessages?.map((m) => m.id)).toEqual(['u1', 'a1'])
    } finally {
      await fs.rm(lock, { force: true })
    }

    const result = await unrevert(sessionId)
    expect(result.done).toBe(true)
    expect(result.files).toBeUndefined()
    expect(await read(dir, 'a.txt')).toBe('turno')
  })
})

describe('file unrevert', () => {
  it('gives back the paths that are still as the revert left them', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'before' },
      turn: { 'a.txt': 'turno' },
    })
    await revert(sessionId, 'u1')
    expect(await read(dir, 'a.txt')).toBe('before')

    const result = await unrevert(sessionId)

    expect(result.done).toBe(true)
    expect(result.files?.restored).toBe(1)
    expect(result.files?.conflicts).toEqual([])
    expect(await read(dir, 'a.txt')).toBe('turno')
  })

  it('does not overwrite what changed between the revert and the unrevert', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'before' },
      turn: { 'a.txt': 'turno' },
    })
    await revert(sessionId, 'u1')
    // Between the revert and the undo, someone writes.
    await fs.writeFile(path.join(dir, 'a.txt'), 'novidade', 'utf8')

    const result = await unrevert(sessionId)

    expect(result.done).toBe(true)
    expect(result.files?.conflicts).toEqual(['a.txt'])
    expect(await read(dir, 'a.txt')).toBe('novidade')
  })
})
