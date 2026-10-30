import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const { __resetWorkspaceLocks, withWorkspaceLock, workspaceLockPending } = await import('./workspace-lock')

/**
 * Two conversations in the SAME folder cannot run turns at the same time: the
 * snapshot of one would land in the middle of the other's write, and the revert of one
 * would take the other's work with it. The queue is per folder — different projects
 * go on in parallel.
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
  it('serializes two turns of the same folder, in arrival order', async () => {
    const order: string[] = []
    const gate = deferred()
    const first = withWorkspaceLock(a, async () => {
      order.push('a-entrou')
      await gate.promise
      order.push('a-saiu')
    })
    const second = withWorkspaceLock(a, async () => {
      order.push('b-entrou')
      order.push('b-saiu')
    })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(order).toEqual(['a-entrou'])

    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['a-entrou', 'a-saiu', 'b-entrou', 'b-saiu'])
  })

  it('different folders run in parallel', async () => {
    const order: string[] = []
    const gate = deferred()
    const one = withWorkspaceLock(a, async () => {
      order.push('a-entrou')
      await gate.promise
    })
    const two = withWorkspaceLock(b, async () => {
      order.push('b-entrou')
    })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(order.sort()).toEqual(['a-entrou', 'b-entrou'])
    gate.resolve()
    await Promise.all([one, two])
  })

  it('is reentrant in the same context (a revert that calls another locked operation)', async () => {
    const result = await withWorkspaceLock(a, async () =>
      withWorkspaceLock(a, async () => 'ok'),
    )
    expect(result).toBe('ok')
  })

  it('a failure does not jam the folder queue', async () => {
    await expect(
      withWorkspaceLock(a, async () => {
        throw new Error('failed')
      }),
    ).rejects.toThrow('failed')
    await expect(withWorkspaceLock(a, async () => 'next')).resolves.toBe('next')
  })

  it('symlink/realpath: the same project with different paths is the same queue', async () => {
    const link = path.join(tmp, 'atalho-a')
    await fs.symlink(a, link)
    const gate = deferred()
    const order: string[] = []
    const one = withWorkspaceLock(a, async () => {
      order.push('real')
      await gate.promise
    })
    const two = withWorkspaceLock(link, async () => {
      order.push('atalho')
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(order).toEqual(['real'])
    gate.resolve()
    await Promise.all([one, two])
    expect(order).toEqual(['real', 'atalho'])
    await fs.rm(link, { force: true })
  })

  it('workspaceLockPending uses the same key as the queue (realpath)', async () => {
    const link = path.join(tmp, 'atalho-pendente')
    await fs.symlink(a, link)
    const gate = deferred()
    const holding = withWorkspaceLock(a, () => gate.promise)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await workspaceLockPending(link)).toBe(true)
    gate.resolve()
    await holding
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await workspaceLockPending(link)).toBe(false)
    await fs.rm(link, { force: true })
  })
})
