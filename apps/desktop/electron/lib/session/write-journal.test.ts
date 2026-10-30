import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const { __resetWriteJournal, coveredBy, currentTurnWrites, detachFromTurn, recordToolWrite, runWithWriteScope } =
  await import('./write-journal')

/**
 * Authorship of the writes in the folder: the revert undoes what the tools of the turn
 * wrote, and not what another conversation (or something external) changed in the same
 * interval.
 */
const repo = path.resolve('/repo')

beforeEach(() => {
  __resetWriteJournal()
})

describe('write-journal', () => {
  it('records what the turn tools wrote, relative to the folder', async () => {
    await runWithWriteScope(async () => {
      recordToolWrite(path.join(repo, 'src', 'a.ts'))
      recordToolWrite(path.join(repo, 'downloads'))
      // Outside the folder does not count.
      recordToolWrite(path.resolve('/other', 'b.ts'))
      expect(currentTurnWrites(repo)).toEqual({ authored: ['downloads', 'src/a.ts'], others: [] })
    })
  })

  it('outside a turn nothing is recorded', () => {
    recordToolWrite(path.join(repo, 'a.ts'))
    expect(currentTurnWrites(repo)).toBeNull()
  })

  it('two parallel turns: the writes of one are "others" for the other', async () => {
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

  it('a write from another turn BEFORE this one started does not count as "others"', async () => {
    await runWithWriteScope(async () => recordToolWrite(path.join(repo, 'old.ts')))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await runWithWriteScope(async () => {
      expect(currentTurnWrites(repo)).toEqual({ authored: [], others: [] })
    })
  })

  it('a nested and awaited turn (worker) counts for it and for the parent', async () => {
    await runWithWriteScope(async () => {
      const filho = await runWithWriteScope(async () => {
        recordToolWrite(path.join(repo, 'do-worker.ts'))
        return currentTurnWrites(repo)
      })
      expect(filho).toEqual({ authored: ['do-worker.ts'], others: [] })
      expect(currentTurnWrites(repo)).toEqual({ authored: ['do-worker.ts'], others: [] })
    })
  })

  it('detachFromTurn: what runs outside the scope is not the parent one', async () => {
    await runWithWriteScope(async () => {
      await detachFromTurn(() => runWithWriteScope(async () => recordToolWrite(path.join(repo, 'subchat.ts'))))
      expect(currentTurnWrites(repo)).toEqual({ authored: [], others: ['subchat.ts'] })
    })
  })

  it('coveredBy: a registered folder covers what is inside it', () => {
    expect(coveredBy('downloads/video.mp4', ['downloads'])).toBe(true)
    expect(coveredBy('downloads', ['downloads'])).toBe(true)
    expect(coveredBy('downloads-2/x', ['downloads'])).toBe(false)
  })
})
