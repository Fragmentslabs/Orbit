import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantSnapshot, ChatMessage, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'

/**
 * Revert com autoria: o que as tools do turno gravaram é desfeito; o que
 * mudou na pasta por outra via (bash, MCP, algo de fora) fica à parte, como
 * "autor incerto", até a pessoa pedir; o que outra conversa gravou no mesmo
 * intervalo nunca entra. E vários turnos descartados voltam do último para o
 * primeiro.
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
  /** O que o turno fez (null apaga). */
  writes: Record<string, string | null>
  /** Caminhos gravados pelas tools do turno; ausente = turno anterior ao diário. */
  authored?: string[]
  /** Caminhos gravados por tools de outra conversa durante o turno. */
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

/** Monta a conversa: um par user/assistant por turno, com o snapshot de cada um. */
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

describe('vários turnos descartados', () => {
  it('voltam do último para o primeiro: nada fica de fora, e editar o mesmo arquivo não é conflito', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'v0' }, [
      { writes: { 'a.txt': 'v1' }, authored: ['a.txt'] },
      { writes: { 'a.txt': 'v2', 'so-do-2.txt': 'novo' }, authored: ['a.txt', 'so-do-2.txt'] },
    ])

    const state = await revert(sessionId, 'u1')

    expect(state?.conflicts).toEqual([])
    expect(state?.files).toEqual(['a.txt', 'so-do-2.txt'])
    expect(await read(dir, 'a.txt')).toBe('v0')
    expect(await exists(dir, 'so-do-2.txt')).toBe(false)
  })

  it('revert a partir do segundo turno não mexe no primeiro', async () => {
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
  it('o que as tools não gravaram vira "autor incerto" e não é revertido', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'antes' }, [
      // `gerado.js` mudou no turno, mas por bash/codegen: sem autoria.
      { writes: { 'a.txt': 'turno', 'gerado.js': 'build' }, authored: ['a.txt'] },
    ])

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual(['a.txt'])
    expect(state?.uncertain).toEqual(['gerado.js'])
    expect(await read(dir, 'a.txt')).toBe('antes')
    expect(await read(dir, 'gerado.js')).toBe('build')
  })

  it('o que outra conversa gravou no intervalo nem entra no revert', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'antes' }, [
      { writes: { 'a.txt': 'turno', 'da-outra.ts': 'outra' }, authored: ['a.txt'], others: ['da-outra.ts'] },
    ])

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual(['a.txt'])
    expect(state?.uncertain).toBeUndefined()
    expect(state?.conflicts).toEqual([])
    expect(await read(dir, 'da-outra.ts')).toBe('outra')
  })

  it('pasta registrada (downloads) cobre os arquivos de dentro', async () => {
    const { dir, sessionId } = await setup({}, [
      { writes: { 'downloads/video.mp4': 'bytes' }, authored: ['downloads'] },
    ])

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual(['downloads/video.mp4'])
    expect(await exists(dir, 'downloads')).toBe(false)
  })

  it('turno anterior ao diário (sem authored): todo o diff conta como dele', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'antes' }, [{ writes: { 'a.txt': 'turno', 'b.txt': 'novo' } }])

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual(['a.txt', 'b.txt'])
    expect(state?.uncertain).toBeUndefined()
    expect(await read(dir, 'a.txt')).toBe('antes')
  })
})

describe('reverter também os incertos', () => {
  it('desfaz os incertos com a mesma regra, e o unrevert devolve tudo', async () => {
    const { dir, sessionId } = await setup({ 'a.txt': 'antes' }, [
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

  it('incerto mexido depois do turno continua preservado', async () => {
    const { dir, sessionId } = await setup({}, [
      { writes: { 'a.txt': 'turno', 'gerado.js': 'build' }, authored: ['a.txt'] },
    ])
    await revert(sessionId, 'u1')
    await fs.writeFile(path.join(dir, 'gerado.js'), 'editado depois', 'utf8')

    const state = await revertUncertain(sessionId)

    expect(state?.conflicts).toEqual(['gerado.js'])
    expect(await read(dir, 'gerado.js')).toBe('editado depois')
  })

  it('caminho confirmado que deu conflito por causa de um incerto do turno seguinte volta junto', async () => {
    // Turno 1 edita a.txt pela tool; turno 2 mexe em a.txt por bash.
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
