import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantSnapshot, ChatMessage, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'

/**
 * Revert with authorship: what the tools of the turn wrote is undone; what
 * changed in the folder another way (bash, MCP, something external) stays apart, as
 * "uncertain author", until the person asks for it; what another conversation wrote in the same
 * interval never comes in. And several discarded turns come back from the last to the
 * first.
 */
const userData = path.join(os.tmpdir(), `orbit-revert-autoria-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const { capture } = await import('../snapshot')
const { readJson, writeJson } = await import('../storage')
const { revert, revertUncertain, unrevert } = await import('./revert')

let counter = 0
const roots: string[] = []

interface TurnSpec {
  /** What the turn did (null deletes). */
  writes: Record<string, string | null>
  /** Paths written by the tools of the turn; absent = turn from before the journal. */
  authored?: string[]
  /** Paths written by tools of another conversation during the turn. */
  others?: string[]
}

async function apply(dir: string, writes: Record<string, string | null>): Promise<void> {
  for (const [rel, content] of Object.entries(writes)) {
    const abs = path.join(dir, rel)
    if (content === null) await fs.rm(abs, { force: true })
    else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf8')
    }
  }
}

/** Assembles the conversation: one user/assistant pair per turn, with the snapshot of each one. */
async function setup(initial: Record<string, string>, turns: TurnSpec[]): Promise<{ dir: string; sessionId: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-revert-autoria-proj-'))
  roots.push(dir)
  await apply(dir, initial)
  const messages: ChatMessage[] = []
  for (const [i, turn] of turns.entries()) {
    const start = await capture(dir)
    await apply(dir, turn.writes)
    const end = await capture(dir)
    const snapshot: AssistantSnapshot = {
      start,
      end,
      verified: 'changed',
      ...(turn.authored ? { authored: turn.authored } : {}),
      ...(turn.others ? { others: turn.others } : {}),
    }
    messages.push(
      { id: `u${i + 1}`, role: 'user', parts: [{ id: `pu${i}`, type: 'text', text: 'mude', state: 'done' }], createdAt: i },
      { id: `a${i + 1}`, role: 'assistant', parts: [], createdAt: i, snapshot },
    )
  }
  const sessionId = `s-autoria-${process.pid}-${counter++}`
  const session: SessionInfo = {
    id: sessionId,
    title: 'Autoria',
    mode: 'code',
    pinned: false,
    archived: false,
    folderId: null,
    directory: dir,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await writeJson(StorageKeys.session(sessionId), session)
  await writeJson(StorageKeys.messages(sessionId), messages)
  return { dir, sessionId }
}

const read = (dir: string, rel: string) => fs.readFile(path.join(dir, rel), 'utf8')
const exists = (dir: string, rel: string) =>
  fs.lstat(path.join(dir, rel)).then(
    () => true,
    () => false,
  )

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80))
})

afterAll(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(userData, { recursive: true, force: true })
})

describe('several discarded turns', () => {
  it('they come back from the last to the first: nothing stays out, and editing the same file is not a conflict', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'v0' }, [
      { writes: { 'a.txt': 'v1' }, authored: ['a.txt'] },
      { writes: { 'a.txt': 'v2', 'so-do-2.txt': 'new' }, authored: ['a.txt', 'so-do-2.txt'] },
    ])

    const state = await revert(sessionId, 'u1')

    expect(state?.conflicts).toEqual([])
    expect(state?.files).toEqual(['a.txt', 'so-do-2.txt'])
    expect(await read(dir, 'a.txt')).toBe('v0')
    expect(await exists(dir, 'so-do-2.txt')).toBe(false)
  })

  it('a revert from the second turn does not touch the first', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'v0' }, [
      { writes: { 'a.txt': 'v1' }, authored: ['a.txt'] },
      { writes: { 'b.txt': 'do 2' }, authored: ['b.txt'] },
    ])

    await revert(sessionId, 'u2')

    expect(await read(dir, 'a.txt')).toBe('v1')
    expect(await exists(dir, 'b.txt')).toBe(false)
  })
})

describe('autoria', () => {
  it('what the tools did not record becomes "uncertain author" and is not reverted', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'before' }, [
      // `gerado.js` changed in the turn, but through bash/codegen: no authorship.
      { writes: { 'a.txt': 'turno', 'gerado.js': 'build' }, authored: ['a.txt'] },
    ])

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual(['a.txt'])
    expect(state?.uncertain).toEqual(['gerado.js'])
    expect(await read(dir, 'a.txt')).toBe('before')
    expect(await read(dir, 'gerado.js')).toBe('build')
  })

  it('what another conversation wrote in between does not even enter the revert', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'before' }, [
      { writes: { 'a.txt': 'turno', 'da-outra.ts': 'other' }, authored: ['a.txt'], others: ['da-outra.ts'] },
    ])

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual(['a.txt'])
    expect(state?.uncertain).toBeUndefined()
    expect(state?.conflicts).toEqual([])
    expect(await read(dir, 'da-outra.ts')).toBe('other')
  })

  it('a registered folder (downloads) covers the files inside it', async () => {
    const { dir, sessionId } = await setup({}, [
      { writes: { 'downloads/video.mp4': 'bytes' }, authored: ['downloads'] },
    ])

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual(['downloads/video.mp4'])
    expect(await exists(dir, 'downloads')).toBe(false)
  })

  it('a turn before the journal (no authored): the whole diff counts as its own', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'before' }, [{ writes: { 'a.txt': 'turno', 'b.txt': 'new' } }])

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual(['a.txt', 'b.txt'])
    expect(state?.uncertain).toBeUndefined()
    expect(await read(dir, 'a.txt')).toBe('before')
  })
})

describe('revert the uncertain ones too', () => {
  it('undoes the uncertain ones by the same rule, and the unrevert gives everything back', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'before' }, [
      { writes: { 'a.txt': 'turno', 'gerado.js': 'build' }, authored: ['a.txt'] },
    ])
    await revert(sessionId, 'u1')

    const state = await revertUncertain(sessionId)

    expect(state?.files).toEqual(['a.txt', 'gerado.js'])
    expect(state?.uncertain).toBeUndefined()
    expect(await exists(dir, 'gerado.js')).toBe(false)
    const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    expect(session?.revert?.uncertain).toBeUndefined()

    const result = await unrevert(sessionId)
    expect(result.files?.restored).toBe(2)
    expect(await read(dir, 'a.txt')).toBe('turno')
    expect(await read(dir, 'gerado.js')).toBe('build')
  })

  it('an uncertain one touched after the turn stays preserved', async () => {
    const { dir, sessionId } = await setup({}, [
      { writes: { 'a.txt': 'turno', 'gerado.js': 'build' }, authored: ['a.txt'] },
    ])
    await revert(sessionId, 'u1')
    await fs.writeFile(path.join(dir, 'gerado.js'), 'edited later', 'utf8')

    const state = await revertUncertain(sessionId)

    expect(state?.conflicts).toEqual(['gerado.js'])
    expect(await read(dir, 'gerado.js')).toBe('edited later')
  })

  it('a confirmed path that conflicted because of an uncertain one from the next turn comes back too', async () => {
    // Turn 1 edits a.txt through the tool; turn 2 touches a.txt through bash.
    const { dir, sessionId } = await setup({ 'a.txt': 'v0' }, [
      { writes: { 'a.txt': 'v1' }, authored: ['a.txt'] },
      { writes: { 'a.txt': 'v2-bash' }, authored: [] },
    ])

    const first = await revert(sessionId, 'u1')
    expect(first?.uncertain).toEqual(['a.txt'])
    expect(first?.conflicts).toEqual(['a.txt'])
    expect(await read(dir, 'a.txt')).toBe('v2-bash')

    const state = await revertUncertain(sessionId)

    expect(state?.files).toEqual(['a.txt'])
    expect(state?.conflicts).toEqual([])
    expect(await read(dir, 'a.txt')).toBe('v0')
  })
})
