import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const { __resetWriteJournal, coveredBy, currentTurnWrites, detachFromTurn, recordToolWrite, runWithWriteScope } =
  await import('./write-journal')

/**
 * Autoria das escritas na pasta: o revert desfaz o que as tools do turno
 * gravaram, e não o que outra conversa (ou algo de fora) mudou no mesmo
 * intervalo.
 */
const repo = path.resolve('/repo')

beforeEach(() => {
  __resetWriteJournal()
})

describe('write-journal', () => {
  it('registra o que as tools do turno gravaram, relativo à pasta', async () => {
    await runWithWriteScope(async () => {
      recordToolWrite(path.join(repo, 'src', 'a.ts'))
      recordToolWrite(path.join(repo, 'downloads'))
      // Fora da pasta não entra.
      recordToolWrite(path.resolve('/outro', 'b.ts'))
      expect(currentTurnWrites(repo)).toEqual({ authored: ['downloads', 'src/a.ts'], others: [] })
    })
  })

  it('fora de um turno nada é registrado', () => {
    recordToolWrite(path.join(repo, 'a.ts'))
    expect(currentTurnWrites(repo)).toBeNull()
  })

  it('dois turnos em paralelo: o de um é "others" para o outro', async () => {
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => (releaseA = resolve))
    let writesA: ReturnType<typeof currentTurnWrites> = null
    const turnoA = runWithWriteScope(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      recordToolWrite(path.join(repo, 'de-a.ts'))
      await gateA
      writesA = currentTurnWrites(repo)
    })
    const turnoB = runWithWriteScope(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      recordToolWrite(path.join(repo, 'de-b.ts'))
      return currentTurnWrites(repo)
    })
    const writesB = await turnoB
    releaseA()
    await turnoA

    expect(writesA).toEqual({ authored: ['de-a.ts'], others: ['de-b.ts'] })
    expect(writesB).toEqual({ authored: ['de-b.ts'], others: ['de-a.ts'] })
  })

  it('escrita de outro turno ANTES deste começar não conta como "others"', async () => {
    await runWithWriteScope(async () => recordToolWrite(path.join(repo, 'velho.ts')))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await runWithWriteScope(async () => {
      expect(currentTurnWrites(repo)).toEqual({ authored: [], others: [] })
    })
  })

  it('turno aninhado e esperado (worker) conta para ele e para o pai', async () => {
    await runWithWriteScope(async () => {
      const filho = await runWithWriteScope(async () => {
        recordToolWrite(path.join(repo, 'do-worker.ts'))
        return currentTurnWrites(repo)
      })
      expect(filho).toEqual({ authored: ['do-worker.ts'], others: [] })
      expect(currentTurnWrites(repo)).toEqual({ authored: ['do-worker.ts'], others: [] })
    })
  })

  it('detachFromTurn: o que roda fora do escopo não é do pai', async () => {
    await runWithWriteScope(async () => {
      await detachFromTurn(() => runWithWriteScope(async () => recordToolWrite(path.join(repo, 'subchat.ts'))))
      expect(currentTurnWrites(repo)).toEqual({ authored: [], others: ['subchat.ts'] })
    })
  })

  it('coveredBy: pasta registrada cobre o que há dentro', () => {
    expect(coveredBy('downloads/video.mp4', ['downloads'])).toBe(true)
    expect(coveredBy('downloads', ['downloads'])).toBe(true)
    expect(coveredBy('downloads-2/x', ['downloads'])).toBe(false)
  })
})
