import fsp from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createWindowsDriver } from './windows'
import type { PersistentRunner } from '../runner'

/**
 * O driver do Windows com um runner falso: confere o que vai ao host (op e
 * args) e como a resposta volta ao contrato. O host de verdade só roda no
 * Windows (Stage 0).
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
  it('capabilities honestas: só UIA no modo dirigido', () => {
    const { run } = fakeRunner({})
    const driver = createWindowsDriver(run)
    expect(driver.platform).toBe('win32')
    expect(driver.capabilities()).toEqual({ directedPointer: true, dragNeedsGlobal: true, accessibilityTree: true, messageMouse: false })
  })

  it('perms devolve as notas do host; requestScreen não precisa de diálogo', async () => {
    const { run } = fakeRunner({ perms: () => ({ accessibility: true, notes: ['Orbit is running without administrator rights.'] }) })
    const driver = createWindowsDriver(run)
    expect(await driver.perms()).toEqual({ accessibility: true, notes: ['Orbit is running without administrator rights.'] })
    expect(await driver.requestScreen()).toEqual({ before: true, granted: true })
  })

  it('apps e tree passam os argumentos sem traduzir (o HWND vai em window.id)', async () => {
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

  it('act manda o op como operação e o resto como argumentos', async () => {
    const { run, calls } = fakeRunner({ element: () => ({ done: 'press', action: 'AXPress' }) })
    const driver = createWindowsDriver(run)
    const result = await driver.act({ op: 'element', pid: 5, window: { id: 1, frame: [0, 0, 1, 1], title: null }, path: [0, 1], ref: 'r:1:AAEC', kind: 'press' })
    expect(result.done).toBe('press')
    expect(calls[0].op).toBe('element')
    expect(calls[0].args).toMatchObject({ pid: 5, ref: 'r:1:AAEC', path: [0, 1], kind: 'press' })
  })

  it('capture lê o PNG que o host gravou e apaga o arquivo', async () => {
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

  it('capture sem imagem propaga o motivo do host', async () => {
    const { run } = fakeRunner({
      capture: () => {
        throw Object.assign(new Error('covered'), { code: 'unavailable' })
      },
    })
    const driver = createWindowsDriver(run)
    await expect(driver.capture(42)).rejects.toThrow(/covered/)
  })
})
