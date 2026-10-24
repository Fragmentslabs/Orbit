import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'

/**
 * Revert por mensagem, ponta a ponta: mensagens + S/E/C por caminho.
 *
 * Os cenários que importam são os de CONCORRÊNCIA: duas conversas na mesma
 * pasta, arquivo mexido por fora depois do turno, e o que muda entre o revert
 * e o unrevert. O revert não pode ser um "restore da pasta inteira".
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
  /** Estado inicial dos arquivos (antes do turno). */
  initial: Record<string, string>
  /** O que o turno fez. */
  turn: Record<string, string | null>
  verified?: 'changed' | 'unchanged'
  /** Caminhos que o turno mudou mas são saves manuais do painel. */
  manual?: string[]
  /** Captura o `end` mesmo num turno 'unchanged' (pasta mudou só por save manual). */
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
  // gc das capturas é fire-and-forget nos snapshots.
  await new Promise((resolve) => setTimeout(resolve, 80))
})

afterAll(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(userData, { recursive: true, force: true })
  roots = []
})

describe('revert de arquivos (S/E/C)', () => {
  it('desfaz só os caminhos do turno, sem tocar no resto da pasta', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'antes', 'intocado.txt': 'fica' },
      turn: { 'a.txt': 'turno', 'novo.txt': 'criado' },
    })

    const state = await revert(sessionId, 'u1')

    expect(state?.filesRestored).toBe(true)
    expect(state?.files?.sort()).toEqual(['a.txt', 'novo.txt'])
    expect(state?.conflicts).toEqual([])
    expect(await read(dir, 'a.txt')).toBe('antes')
    expect(await exists(dir, 'novo.txt')).toBe(false)
    expect(await read(dir, 'intocado.txt')).toBe('fica')
  })

  it('duas conversas na mesma pasta: o que a outra mudou depois do turno fica', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'antes' },
      turn: { 'a.txt': 'turno' },
    })
    // Outra conversa no MESMO projeto escreve depois do snapshot final.
    await fs.writeFile(path.join(dir, 'a.txt'), 'outra conversa', 'utf8')

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual([])
    expect(state?.conflicts).toEqual(['a.txt'])
    expect(await read(dir, 'a.txt')).toBe('outra conversa')
  })

  it('turno de leitura não reseta a pasta', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'estável' },
      turn: {},
      verified: 'unchanged',
    })
    const state = await revert(sessionId, 'u1')
    expect(state?.filesRestored).toBe(true)
    expect(state?.files).toBeUndefined()
    expect(await read(dir, 'a.txt')).toBe('estável')
  })

  it('save manual do painel durante o turno é preservado e reportado', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'antes', 'manual.txt': 'antes' },
      turn: { 'a.txt': 'turno', 'manual.txt': 'salvo à mão' },
      manual: ['manual.txt'],
    })

    const state = await revert(sessionId, 'u1')

    expect(state?.files).toEqual(['a.txt'])
    expect(state?.conflicts).toEqual(['manual.txt'])
    expect(await read(dir, 'a.txt')).toBe('antes')
    expect(await read(dir, 'manual.txt')).toBe('salvo à mão')
  })

  it('turno só com save manual (unchanged + end): preserva o save e reporta', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'antes' },
      turn: { 'a.txt': 'salvo à mão' },
      verified: 'unchanged',
      captureEnd: true,
      manual: ['a.txt'],
    })

    const state = await revert(sessionId, 'u1')

    expect(state?.filesRestored).toBe(true)
    expect(state?.files).toEqual([])
    expect(state?.conflicts).toEqual(['a.txt'])
    expect(await read(dir, 'a.txt')).toBe('salvo à mão')
  })

  it('revert espera o turno de outra conversa na mesma pasta (trava por workspace)', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'antes' },
      turn: { 'a.txt': 'turno' },
    })
    // Simula um turno da mesma pasta rodando: o revert tem de esperar.
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
    expect(await read(dir, 'a.txt')).toBe('antes')
  })
})

describe('unrevert de arquivos', () => {
  it('devolve os caminhos que ainda estão como o revert os deixou', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'antes' },
      turn: { 'a.txt': 'turno' },
    })
    await revert(sessionId, 'u1')
    expect(await read(dir, 'a.txt')).toBe('antes')

    const result = await unrevert(sessionId)

    expect(result.done).toBe(true)
    expect(result.files?.restored).toBe(1)
    expect(result.files?.conflicts).toEqual([])
    expect(await read(dir, 'a.txt')).toBe('turno')
  })

  it('não sobrescreve o que mudou entre o revert e o unrevert', async () => {
    const { dir, sessionId } = await setup({
      initial: { 'a.txt': 'antes' },
      turn: { 'a.txt': 'turno' },
    })
    await revert(sessionId, 'u1')
    // Entre o revert e o desfazer, alguém escreve.
    await fs.writeFile(path.join(dir, 'a.txt'), 'novidade', 'utf8')

    const result = await unrevert(sessionId)

    expect(result.done).toBe(true)
    expect(result.files?.conflicts).toEqual(['a.txt'])
    expect(await read(dir, 'a.txt')).toBe('novidade')
  })
})
