import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createBridgeRunner, type BridgeSpawn } from './runner'

/**
 * O runner é o que impede a bridge de travar o turno: timeout, abort e saída
 * ilegível viram ComputerError — nunca uma exceção crua do child_process.
 */

function fakeSpawn(behavior: { stdout?: string; delayMs?: number; neverExit?: boolean }) {
  const calls: string[][] = []
  const killed: string[] = []
  const spawn: BridgeSpawn = (_command, args) => {
    calls.push(args)
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (signal?: string) => {
        killed.push(signal ?? 'SIGTERM')
        child.emit('close', null)
      },
    })
    if (!behavior.neverExit) {
      setTimeout(() => {
        if (behavior.stdout) child.stdout.write(behavior.stdout)
        child.emit('close', 0)
      }, behavior.delayMs ?? 0)
    }
    return child
  }
  return { spawn, calls, killed }
}

const base = async () => ['-l', 'JavaScript', '/tmp/bridge.js']

describe('createBridgeRunner', () => {
  it('manda op + args como JSON no último argumento e devolve o result', async () => {
    const fake = fakeSpawn({ stdout: JSON.stringify({ ok: true, result: { accessibility: true } }) })
    const run = createBridgeRunner('osascript', base, fake.spawn)
    await expect(run('perms', { a: 1 }, { timeoutMs: 1000 })).resolves.toEqual({ accessibility: true })
    expect(JSON.parse(fake.calls[0].at(-1)!)).toEqual({ op: 'perms', args: { a: 1 } })
  })

  it('erro da bridge vira ComputerError com o código dela', async () => {
    const fake = fakeSpawn({ stdout: JSON.stringify({ ok: false, error: { code: 'axDenied', message: 'no' } }) })
    const run = createBridgeRunner('osascript', base, fake.spawn)
    await expect(run('tree', {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'axDenied' })
  })

  it('timeout mata o processo e explica', async () => {
    const fake = fakeSpawn({ neverExit: true })
    const run = createBridgeRunner('osascript', base, fake.spawn)
    await expect(run('tree', {}, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' })
    expect(fake.killed).toContain('SIGKILL')
  })

  it('abort no meio mata o processo', async () => {
    const fake = fakeSpawn({ neverExit: true })
    const run = createBridgeRunner('osascript', base, fake.spawn)
    const controller = new AbortController()
    const pending = run('tree', {}, { timeoutMs: 5000, signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect(fake.killed).toContain('SIGKILL')
  })

  it('já abortado nem sobe o processo', async () => {
    const fake = fakeSpawn({})
    const run = createBridgeRunner('osascript', base, fake.spawn)
    const controller = new AbortController()
    controller.abort()
    await expect(run('tree', {}, { timeoutMs: 1000, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' })
    expect(fake.calls).toHaveLength(0)
  })

  it('saída vazia ou ilegível é erro acionável', async () => {
    const empty = createBridgeRunner('osascript', base, fakeSpawn({ stdout: '' }).spawn)
    await expect(empty('apps', {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'bridgeError' })
    const junk = createBridgeRunner('osascript', base, fakeSpawn({ stdout: 'execution error: boom' }).spawn)
    await expect(junk('apps', {}, { timeoutMs: 1000 })).rejects.toThrow(/Unreadable/)
  })
})
