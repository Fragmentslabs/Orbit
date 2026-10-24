import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const { __resetWorkspaceLocks, withWorkspaceLock, workspaceLockPending } = await import('./workspace-lock')

/**
 * Duas conversas na MESMA pasta não podem rodar turnos ao mesmo tempo: o
 * snapshot de uma sairia no meio da escrita da outra, e o revert de uma
 * levaria junto o trabalho da outra. A fila é por pasta — projetos diferentes
 * seguem em paralelo.
 */
let tmp: string
let a: string
let b: string

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-workspace-lock-'))
  a = path.join(tmp, 'projeto-a')
  b = path.join(tmp, 'projeto-b')
  await fs.mkdir(a)
  await fs.mkdir(b)
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  __resetWorkspaceLocks()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('withWorkspaceLock', () => {
  it('serializa dois turnos da mesma pasta, na ordem de chegada', async () => {
    const order: string[] = []
    const gate = deferred()
    const primeiro = withWorkspaceLock(a, async () => {
      order.push('a-entrou')
      await gate.promise
      order.push('a-saiu')
    })
    const segundo = withWorkspaceLock(a, async () => {
      order.push('b-entrou')
      order.push('b-saiu')
    })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(order).toEqual(['a-entrou'])

    gate.resolve()
    await Promise.all([primeiro, segundo])
    expect(order).toEqual(['a-entrou', 'a-saiu', 'b-entrou', 'b-saiu'])
  })

  it('pastas diferentes rodam em paralelo', async () => {
    const order: string[] = []
    const gate = deferred()
    const um = withWorkspaceLock(a, async () => {
      order.push('a-entrou')
      await gate.promise
    })
    const dois = withWorkspaceLock(b, async () => {
      order.push('b-entrou')
    })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(order.sort()).toEqual(['a-entrou', 'b-entrou'])
    gate.resolve()
    await Promise.all([um, dois])
  })

  it('é reentrante no mesmo contexto (revert que chama outra operação travada)', async () => {
    const result = await withWorkspaceLock(a, async () =>
      withWorkspaceLock(a, async () => 'ok'),
    )
    expect(result).toBe('ok')
  })

  it('uma falha não trava a fila da pasta', async () => {
    await expect(
      withWorkspaceLock(a, async () => {
        throw new Error('falhou')
      }),
    ).rejects.toThrow('falhou')
    await expect(withWorkspaceLock(a, async () => 'seguinte')).resolves.toBe('seguinte')
  })

  it('symlink/realpath: o mesmo projeto com caminhos diferentes é a mesma fila', async () => {
    const link = path.join(tmp, 'atalho-a')
    await fs.symlink(a, link)
    const gate = deferred()
    const order: string[] = []
    const um = withWorkspaceLock(a, async () => {
      order.push('real')
      await gate.promise
    })
    const dois = withWorkspaceLock(link, async () => {
      order.push('atalho')
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(order).toEqual(['real'])
    gate.resolve()
    await Promise.all([um, dois])
    expect(order).toEqual(['real', 'atalho'])
    await fs.rm(link, { force: true })
  })

  it('workspaceLockPending usa a mesma chave da fila (realpath)', async () => {
    const link = path.join(tmp, 'atalho-pendente')
    await fs.symlink(a, link)
    const gate = deferred()
    const segurando = withWorkspaceLock(a, () => gate.promise)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await workspaceLockPending(link)).toBe(true)
    gate.resolve()
    await segurando
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await workspaceLockPending(link)).toBe(false)
    await fs.rm(link, { force: true })
  })
})
