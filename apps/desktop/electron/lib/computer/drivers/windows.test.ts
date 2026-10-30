import fsp from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createWindowsDriver } from './windows'
import type { PersistentRunner } from '../runner'

/**
 * The Windows driver with a fake runner: it checks what goes to the host (op and args)
 * and how the response comes back to the contract. The real host only runs on Windows
 * (Stage 0).
 */

function fakeRunner(replies: Record<string, (args: unknown) => unknown>) {
  const calls: { op: string; args: unknown; timeoutMs: number }[] = []
  const run = (async (op: string, args: unknown, options: { timeoutMs: number }) => {
    calls.push({ op, args, timeoutMs: options.timeoutMs })
    const reply = replies[op]
    if (!reply) throw new Error(`unexpected op ${op}`)
    return reply(args)
  }) as unknown as PersistentRunner
  run.dispose = () => undefined
  run.alive = () => true
  return { run, calls }
}

describe('createWindowsDriver', () => {
  it('honest capabilities: only UIA in steered mode', () => {
    const { run } = fakeRunner({})
    const driver = createWindowsDriver(run)
    expect(driver.platform).toBe('win32')
    expect(driver.capabilities()).toEqual({ directedPointer: true, dragNeedsGlobal: true, accessibilityTree: true, messageMouse: false })
  })

  it('perms returns the host notes; requestScreen needs no dialog', async () => {
    const { run } = fakeRunner({ perms: () => ({ accessibility: true, notes: ['Orbit is running without administrator rights.'] }) })
    const driver = createWindowsDriver(run)
    expect(await driver.perms()).toEqual({ accessibility: true, notes: ['Orbit is running without administrator rights.'] })
    expect(await driver.requestScreen()).toEqual({ before: true, granted: true })
  })

  it('apps and tree pass the arguments through untranslated (the HWND goes in window.id)', async () => {
    const { run, calls } = fakeRunner({
      apps: () => ({ apps: [], windows: [] }),
      tree: () => ({ nodes: [], focusedId: null, truncated: null, omitted: 0, timeouts: 0, enhanced: false, ms: 3 }),
    })
    const driver = createWindowsDriver(run)
    await driver.apps()
    const request = { pid: 10, window: { id: 264748, frame: [0, 0, 800, 600] as [number, number, number, number], title: 'x' }, maxNodes: 250 }
    await driver.tree(request)
    expect(calls.map((c) => c.op)).toEqual(['apps', 'tree'])
    expect(calls[1].args).toEqual(request)
  })

  it('act sends the op as operation and the rest as arguments', async () => {
    const { run, calls } = fakeRunner({ element: () => ({ done: 'press', action: 'AXPress' }) })
    const driver = createWindowsDriver(run)
    const result = await driver.act({ op: 'element', pid: 5, window: { id: 1, frame: [0, 0, 1, 1], title: null }, path: [0, 1], ref: 'r:1:AAEC', kind: 'press' })
    expect(result.done).toBe('press')
    expect(calls[0].op).toBe('element')
    expect(calls[0].args).toMatchObject({ pid: 5, ref: 'r:1:AAEC', path: [0, 1], kind: 'press' })
  })

  it('capture reads the PNG the host wrote and deletes the file', async () => {
    let written = ''
    const { run } = fakeRunner({
      capture: async (args) => {
        const { file } = args as { file: string }
        written = file
        await fsp.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        return { file, width: 10, height: 10, method: 'printwindow' }
      },
    })
    const driver = createWindowsDriver(run)
    const png = await driver.capture(42)
    expect([...png]).toEqual([0x89, 0x50, 0x4e, 0x47])
    await expect(fsp.stat(written)).rejects.toThrow()
  })

  it('capture with no image propagates the host reason', async () => {
    const { run } = fakeRunner({
      capture: () => {
        throw Object.assign(new Error('covered'), { code: 'unavailable' })
      },
    })
    const driver = createWindowsDriver(run)
    await expect(driver.capture(42)).rejects.toThrow(/covered/)
  })
})
