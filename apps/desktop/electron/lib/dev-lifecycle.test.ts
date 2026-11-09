import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const { isDevRun, isLauncherGone, watchDevLauncher } = await import('./dev-lifecycle')

describe('isLauncherGone', () => {
  it('is false while the launcher is the same live process', () => {
    expect(isLauncherGone(100, { currentParent: () => 100, isAlive: () => true })).toBe(false)
  })

  it('is true when the launcher no longer exists', () => {
    expect(isLauncherGone(100, { currentParent: () => 100, isAlive: () => false })).toBe(true)
  })

  it('is true when the process was handed to another parent (orphaned)', () => {
    expect(isLauncherGone(100, { currentParent: () => 1, isAlive: () => true })).toBe(true)
  })
})

describe('watchDevLauncher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires once when the launcher disappears, and not before', () => {
    let alive = true
    const onGone = vi.fn()
    watchDevLauncher(onGone, 1000, { currentParent: () => 100, isAlive: () => alive })
    vi.advanceTimersByTime(3000)
    expect(onGone).not.toHaveBeenCalled()
    alive = false
    vi.advanceTimersByTime(1000)
    vi.advanceTimersByTime(5000)
    expect(onGone).toHaveBeenCalledTimes(1)
  })

  it('has nothing to follow when it was not launched by a real parent', () => {
    const onGone = vi.fn()
    watchDevLauncher(onGone, 1000, { currentParent: () => 1, isAlive: () => false })
    vi.advanceTimersByTime(5000)
    expect(onGone).not.toHaveBeenCalled()
  })

  it('stops watching when asked', () => {
    const onGone = vi.fn()
    const stop = watchDevLauncher(onGone, 1000, { currentParent: () => 100, isAlive: () => false })
    stop()
    vi.advanceTimersByTime(5000)
    expect(onGone).not.toHaveBeenCalled()
  })
})

describe('isDevRun', () => {
  it('is true when the app is not packaged', () => {
    expect(isDevRun()).toBe(true)
  })
})
