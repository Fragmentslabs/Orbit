import { describe, expect, it } from 'vitest'
import { acquireHeavySlot, heavySlots, heavyState, isHeavyCommand } from './heavy-commands'

const GB = 1024 ** 3

describe('isHeavyCommand', () => {
  it('compilers, test runners, linters and builds are heavy', () => {
    for (const command of [
      'npx tsc --noEmit',
      'cd apps/desktop && npx vitest run electron/lib',
      'npm run typecheck',
      'pnpm test',
      'yarn lint',
      'npm run test:unit',
      'npx eslint . --ext ts,tsx',
      'cargo test',
      'python -m pytest tests/',
      'next build',
    ]) {
      expect(isHeavyCommand(command), command).toBe(true)
    }
  })

  it('light commands and watchers never wait', () => {
    for (const command of [
      'git status',
      'rg "tsc" src',
      'ls -la',
      'node scripts/one-off.mjs',
      'npm run dev',
      'npx vitest --watch',
      'npx tsc -w',
      'cat tsconfig.json',
      'npm install',
    ]) {
      expect(isHeavyCommand(command), command).toBe(false)
    }
  })
})

describe('heavySlots', () => {
  it('one slot per 8 GB, at least one, and the env override wins', () => {
    expect(heavySlots(4 * GB, undefined)).toBe(1)
    expect(heavySlots(16 * GB, undefined)).toBe(2)
    expect(heavySlots(64 * GB, undefined)).toBe(8)
    expect(heavySlots(16 * GB, '1')).toBe(1)
    expect(heavySlots(16 * GB, 'abc')).toBe(2)
  })
})

describe('acquireHeavySlot', () => {
  it('queues beyond the cap and hands the slot over in order', async () => {
    const first = await acquireHeavySlot(undefined, 1)
    const order: string[] = []
    const second = acquireHeavySlot(undefined, 1).then((release) => {
      order.push('second')
      return release
    })
    await Promise.resolve()
    expect(order).toEqual([])
    expect(heavyState()).toEqual({ running: 1, waiting: 1 })
    first()
    first() // releasing twice frees one slot only
    const release = await second
    expect(order).toEqual(['second'])
    expect(heavyState()).toEqual({ running: 1, waiting: 0 })
    release()
    expect(heavyState()).toEqual({ running: 0, waiting: 0 })
  })

  it('an abort while waiting gives the place up', async () => {
    const holder = await acquireHeavySlot(undefined, 1)
    const controller = new AbortController()
    const waiting = acquireHeavySlot(controller.signal, 1)
    controller.abort()
    await expect(waiting).rejects.toBeDefined()
    expect(heavyState().waiting).toBe(0)
    holder()
    expect(heavyState().running).toBe(0)
  })
})
