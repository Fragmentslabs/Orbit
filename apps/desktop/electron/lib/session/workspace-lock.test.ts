import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const {
  __resetWorkspaceLocks,
  abortQueuedTurns,
  linkQueuedAbort,
  outsideWorkspaceLocks,
  queuedTurnSessionIds,
  queuedWorkspaceTurn,
  withWorkspaceLock,
} = await import('./workspace-lock')

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

  it('é reentrante no mesmo contexto (worker/loop do mesmo turno)', async () => {
    const result = await withWorkspaceLock(a, async () =>
      withWorkspaceLock(a, async () => 'ok'),
    )
    expect(result).toBe('ok')
  })

  it('turno disparado sem await fora do contexto (subchat) espera o pai terminar', async () => {
    const order: string[] = []
    const gate = deferred()
    let filho: Promise<void> | undefined
    const pai = withWorkspaceLock(a, async () => {
      order.push('pai-entrou')
      // Como o subchat: disparado no meio do turno, sem esperar por ele.
      filho = outsideWorkspaceLocks(() =>
        withWorkspaceLock(a, async () => {
          order.push('filho-entrou')
        }),
      )
      await gate.promise
      order.push('pai-saiu')
    })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(order).toEqual(['pai-entrou'])

    gate.resolve()
    await pai
    await filho
    expect(order).toEqual(['pai-entrou', 'pai-saiu', 'filho-entrou'])
  })

  it('o filho fora do contexto não fura a fila de outra conversa que já esperava', async () => {
    const order: string[] = []
    const gate = deferred()
    let filho: Promise<void> | undefined
    const pai = withWorkspaceLock(a, async () => {
      await gate.promise
      filho = outsideWorkspaceLocks(() =>
        withWorkspaceLock(a, async () => {
          order.push('filho')
        }),
      )
    })
    const outra = withWorkspaceLock(a, async () => {
      order.push('outra')
    })
    gate.resolve()
    await Promise.all([pai, outra])
    await filho
    expect(order).toEqual(['outra', 'filho'])
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
})

describe('queuedWorkspaceTurn', () => {
  it('parar enquanto espera a pasta: o turno começa com o sinal abortado', async () => {
    const gate = deferred()
    const outra = withWorkspaceLock(a, () => gate.promise)
    let abortadoNaPartida: boolean | undefined
    const turno = queuedWorkspaceTurn('ses_1', a, async (queued) => {
      abortadoNaPartida = queued.aborted
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    // Na fila: aparece como rodando (spinner/botão de parar após reload).
    expect(queuedTurnSessionIds()).toEqual(['ses_1'])
    abortQueuedTurns('ses_1')

    gate.resolve()
    await Promise.all([outra, turno])
    expect(abortadoNaPartida).toBe(true)
    expect(queuedTurnSessionIds()).toEqual([])
  })

  it('parar outra sessão não afeta o turno da fila', async () => {
    const gate = deferred()
    const outra = withWorkspaceLock(a, () => gate.promise)
    let abortado: boolean | undefined
    const turno = queuedWorkspaceTurn('ses_1', a, async (queued) => {
      abortado = queued.aborted
    })
    abortQueuedTurns('ses_2')
    gate.resolve()
    await Promise.all([outra, turno])
    expect(abortado).toBe(false)
  })

  it('linkQueuedAbort: parado antes nasce abortado; parado depois aborta o turno', () => {
    const antes = new AbortController()
    antes.abort()
    const turnoA = new AbortController()
    linkQueuedAbort(antes.signal, turnoA)
    expect(turnoA.signal.aborted).toBe(true)

    const depois = new AbortController()
    const turnoB = new AbortController()
    linkQueuedAbort(depois.signal, turnoB)
    expect(turnoB.signal.aborted).toBe(false)
    depois.abort()
    expect(turnoB.signal.aborted).toBe(true)
  })
})
