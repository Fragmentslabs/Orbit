import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createPersistentRunner, type PersistentChild, type PersistentSpawn } from './runner'

/**
 * The simulated persistent Windows host: it reads one JSON line per request and
 * answers according to the `op`. It checks the correlation by id, that timeout and
 * abort kill the host and it comes back on the next use, and that UTF-8 split across
 * chunks and lines off the protocol break nothing.
 */

type Reply = (req: { id: number; op: string; args: unknown }, out: PassThrough, child: FakeChild) => void

interface FakeChild extends PersistentChild {
  emit(event: string, ...args: unknown[]): boolean
}

function fakeHost(reply: Reply) {
  const spawned: string[][] = []
  const killed: string[] = []
  const received: { id: number; op: string; args: unknown }[] = []
  const spawn: PersistentSpawn = (_command, args) => {
    spawned.push(args)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: (signal?: string) => {
        killed.push(signal ?? 'SIGTERM')
        setImmediate(() => child.emit('close', null))
      },
    }) as unknown as FakeChild
    let buf = ''
    stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const req = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        received.push(req)
        reply(req, stdout, child)
        nl = buf.indexOf('\n')
      }
    })
    return child
  }
  return { spawn, spawned, killed, received }
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`
const base = async () => ['-NoProfile', '-File', 'C:\\orbit\\windows.ps1']

describe('createPersistentRunner', () => {
  it('one host for several operations, each answer matched by id (even out of order)', async () => {
    const pending: [number, PassThrough][] = []
    const host = fakeHost((req, out) => {
      if (req.op === 'slowish') pending.push([req.id, out])
      else {
        out.write(line({ id: req.id, ok: true, result: { op: req.op, args: req.args } }))
        // Answers the slow one after the fast one: the order does not matter, the id does.
        for (const [id, o] of pending.splice(0)) o.write(line({ id, ok: true, result: 'slow' }))
      }
    })
    const run = createPersistentRunner('powershell.exe', base, host.spawn)
    const [a, b] = await Promise.all([run('slowish', {}, { timeoutMs: 1000 }), run('apps', { x: 1 }, { timeoutMs: 1000 })])
    expect(a).toBe('slow')
    expect(b).toEqual({ op: 'apps', args: { x: 1 } })
    expect(await run('tree', { pid: 4 }, { timeoutMs: 1000 })).toEqual({ op: 'tree', args: { pid: 4 } })
    expect(host.spawned).toEqual([['-NoProfile', '-File', 'C:\\orbit\\windows.ps1']])
    expect(host.received.map((r) => r.op)).toEqual(['slowish', 'apps', 'tree'])
  })

  it('a host error becomes ComputerError with its code', async () => {
    const host = fakeHost((req, out) => out.write(line({ id: req.id, ok: false, error: { code: 'elevated', message: 'App is elevated.' } })))
    const run = createPersistentRunner('powershell.exe', base, host.spawn)
    await expect(run('mouse', {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'elevated', message: 'App is elevated.' })
  })

  it('timeout: records the outcome, kills the host, fails the other pending ones and comes back on the next use', async () => {
    let answer = false
    const host = fakeHost((req, out) => {
      if (answer) out.write(line({ id: req.id, ok: true, result: 'ok' }))
    })
    const run = createPersistentRunner('powershell.exe', base, host.spawn)
    const stuck = run('tree', {}, { timeoutMs: 30 })
    const queued = run('apps', {}, { timeoutMs: 5000 })
    await expect(stuck).rejects.toMatchObject({ code: 'timeout' })
    await expect(queued).rejects.toMatchObject({ code: 'bridgeError', message: expect.stringMatching(/restarted/) })
    expect(host.killed).toEqual(['SIGKILL'])
    expect(run.alive()).toBe(false)
    answer = true
    expect(await run('apps', {}, { timeoutMs: 1000 })).toBe('ok')
    expect(host.spawned).toHaveLength(2)
  })

  it('the first request of each host gets the startup deadline', async () => {
    const host = fakeHost((req, out) => {
      setTimeout(() => out.write(line({ id: req.id, ok: true, result: req.op })), 60)
    })
    const run = createPersistentRunner('powershell.exe', base, host.spawn, { startupGraceMs: 200 })
    expect(await run('perms', {}, { timeoutMs: 20 })).toBe('perms')
    // After the first response, the deadline is only the one of the operation.
    await expect(run('apps', {}, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('abort kills the host and says it was stopped', async () => {
    const host = fakeHost(() => undefined)
    const run = createPersistentRunner('powershell.exe', base, host.spawn)
    const controller = new AbortController()
    const p = run('tree', {}, { timeoutMs: 5000, signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
    expect(host.killed).toEqual(['SIGKILL'])
    await expect(run('tree', {}, { timeoutMs: 100, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' })
  })

  it('a dying host fails the pending one with the end of stderr', async () => {
    const host = fakeHost((_req, _out, child) => {
      const stderr = child.stderr as unknown as PassThrough
      stderr.write('Add-Type : Cannot add type. Constrained language mode.\n')
      setImmediate(() => child.emit('close', 1))
    })
    const run = createPersistentRunner('powershell.exe', base, host.spawn)
    await expect(run('apps', {}, { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'bridgeError',
      message: expect.stringMatching(/exited \(code 1\).*Constrained language mode/),
    })
  })

  it('UTF-8 split across chunks, several lines in one chunk and a line outside the protocol', async () => {
    const host = fakeHost((req, out) => {
      if (req.op === 'type') {
        const bytes = Buffer.from(line({ id: req.id, ok: true, result: 'ação — olá 😀' }), 'utf8')
        // Cuts in the middle of the emoji.
        const cut = bytes.indexOf(Buffer.from('😀', 'utf8')) + 2
        out.write('WARNING: loose warning from PowerShell\n')
        out.write(bytes.subarray(0, cut))
        setTimeout(() => out.write(bytes.subarray(cut)), 5)
      } else {
        out.write(line({ id: req.id, ok: true, result: 1 }) + line({ id: 999, ok: true, result: 'orphan' }))
      }
    })
    const run = createPersistentRunner('powershell.exe', base, host.spawn)
    expect(await run('type', { text: 'olá' }, { timeoutMs: 1000 })).toBe('ação — olá 😀')
    expect(await run('apps', {}, { timeoutMs: 1000 })).toBe(1)
    expect(host.received[0].args).toEqual({ text: 'olá' })
  })

  it('dispose encerra o host', async () => {
    const host = fakeHost((req, out) => out.write(line({ id: req.id, ok: true, result: true })))
    const run = createPersistentRunner('powershell.exe', base, host.spawn)
    await run('perms', {}, { timeoutMs: 1000 })
    expect(run.alive()).toBe(true)
    run.dispose()
    expect(run.alive()).toBe(false)
    expect(host.killed).toEqual(['SIGKILL'])
  })
})
