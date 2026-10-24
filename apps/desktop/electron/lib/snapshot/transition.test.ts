import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Transição S/E/C por caminho — o revert que não toca no resto da pasta.
 *
 * S = estado antes do turno, E = estado depois, C = worktree agora. Cada caso
 * aqui é uma resposta a "outra conversa mexeu nesse arquivo depois do turno?".
 */
const userData = path.join(os.tmpdir(), `orbit-transition-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}))

const { capture, diffPaths, transition } = await import('./index')

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-transition-proj-'))
})

afterEach(async () => {
  // O gc da captura é fire-and-forget: sem esperar, ele ainda estaria de pé
  // quando o temporário fosse apagado.
  await new Promise((resolve) => setTimeout(resolve, 80))
  await fs.rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), content, 'utf8')
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8')
}

async function exists(rel: string): Promise<boolean> {
  return fs.lstat(path.join(root, rel)).then(
    () => true,
    () => false,
  )
}

describe('transition', () => {
  it('devolve um arquivo modificado ao conteúdo do turno anterior', async () => {
    await write('a.txt', 'um')
    const start = await capture(root)
    await write('a.txt', 'dois')
    const end = await capture(root)

    const result = await transition(root, end, start)

    expect(result).toEqual({ applied: ['a.txt'], conflicts: [], already: [] })
    expect(await read('a.txt')).toBe('um')
  })

  it('apaga o arquivo criado pelo turno e devolve o que ele apagou', async () => {
    await write('apagado.txt', 'volta')
    const start = await capture(root)
    await write('novo.txt', 'criado')
    await fs.rm(path.join(root, 'apagado.txt'))
    const end = await capture(root)

    const result = await transition(root, end, start)

    expect(result.applied.sort()).toEqual(['apagado.txt', 'novo.txt'])
    expect(await exists('novo.txt')).toBe(false)
    expect(await read('apagado.txt')).toBe('volta')
  })

  it('NÃO toca no arquivo que outra conversa mudou depois do turno', async () => {
    await write('a.txt', 'antes')
    const start = await capture(root)
    await write('a.txt', 'turno')
    const end = await capture(root)
    // Depois do turno, outra conversa (ou o usuário fora do Orbit) escreve.
    await write('a.txt', 'outra conversa')

    const result = await transition(root, end, start)

    expect(result.applied).toEqual([])
    expect(result.conflicts).toEqual(['a.txt'])
    expect(await read('a.txt')).toBe('outra conversa')
  })

  it('não apaga o arquivo criado pelo turno que foi editado depois', async () => {
    const start = await capture(root)
    await write('novo.txt', 'do turno')
    const end = await capture(root)
    await write('novo.txt', 'editado depois')

    const result = await transition(root, end, start)

    expect(result.conflicts).toEqual(['novo.txt'])
    expect(await read('novo.txt')).toBe('editado depois')
  })

  it('turno sem escrita não mexe em nada', async () => {
    await write('a.txt', 'estável')
    const start = await capture(root)
    const end = await capture(root)

    const result = await transition(root, end, start)

    expect(result).toEqual({ applied: [], conflicts: [], already: [] })
    expect(await read('a.txt')).toBe('estável')
  })

  it('symlink volta ao alvo anterior (hash de symlink, não de arquivo seguido)', async () => {
    await write('um.txt', 'um')
    await write('dois.txt', 'dois')
    await fs.symlink('um.txt', path.join(root, 'link'))
    const start = await capture(root)
    await fs.rm(path.join(root, 'link'))
    await fs.symlink('dois.txt', path.join(root, 'link'))
    const end = await capture(root)

    const result = await transition(root, end, start)

    expect(result.applied).toEqual(['link'])
    expect(await fs.readlink(path.join(root, 'link'))).toBe('um.txt')
  })

  it('caminhos pulados (save manual do painel) viram conflito, preservados', async () => {
    await write('a.txt', 'antes')
    await write('manual.txt', 'antes')
    const start = await capture(root)
    await write('a.txt', 'turno')
    await write('manual.txt', 'salvo à mão')
    const end = await capture(root)

    const result = await transition(root, end, start, new Set(['manual.txt']))

    expect(result.applied).toEqual(['a.txt'])
    expect(result.conflicts).toEqual(['manual.txt'])
    expect(await read('a.txt')).toBe('antes')
    expect(await read('manual.txt')).toBe('salvo à mão')
  })

  it('unrevert: só devolve o caminho que ainda está no estado deixado pelo revert', async () => {
    await write('a.txt', 'antes')
    const start = await capture(root)
    await write('a.txt', 'turno')
    const end = await capture(root)
    await transition(root, end, start)
    const afterRevert = await capture(root)
    // Alguém mexe entre o revert e o unrevert.
    await write('a.txt', 'novidade')

    const result = await transition(root, afterRevert, end)

    expect(result.conflicts).toEqual(['a.txt'])
    expect(await read('a.txt')).toBe('novidade')
  })

  it('diffPaths mostra só o diff dos caminhos aplicados', async () => {
    await write('a.txt', 'um')
    await write('b.txt', 'um')
    const start = await capture(root)
    await write('a.txt', 'dois')
    await write('b.txt', 'dois')
    const end = await capture(root)

    const changes = await diffPaths(root, start, end, ['a.txt'])

    expect(changes.files).toEqual(['a.txt'])
    expect(changes.patch).toContain('a/a.txt')
    expect(changes.patch).not.toContain('b/b.txt')
  })
})
