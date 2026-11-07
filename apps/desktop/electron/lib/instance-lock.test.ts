import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claimDevInstance, claimInstance, type InstanceLockDeps } from './instance-lock'

/**
 * The dev restart: the new instance waits for the previous one to leave, it does not quit
 * (which used to take the dev server down and leave the old window black).
 */

const dirs: string[] = []
const children: ChildProcess[] = []
const newProfile = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orbit-instance-'))
  dirs.push(dir)
  return dir
}
const pidFile = (dir: string) => path.join(dir, '.dev-instance.pid')

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake clock: sleeping advances time, and `onTick` can change the world between polls. */
function fakeDeps(isOurs: (pid: number) => boolean, onTick?: (tick: number) => void): InstanceLockDeps {
  let time = 0
  let ticks = 0
  return {
    isOurs,
    now: () => time,
    sleep: async (ms) => {
      time += ms
      onTick?.(++ticks)
    },
  }
}

describe('claimDevInstance', () => {
  it('takes the profile at once when nobody has it, and writes its pid', async () => {
    const dir = newProfile()
    expect(await claimDevInstance(dir, fakeDeps(() => false), 1000)).toBe(true)
    expect(readFileSync(pidFile(dir), 'utf8')).toBe(String(process.pid))
  })

  it('ignores a stale file whose process is gone', async () => {
    const dir = newProfile()
    writeFileSync(pidFile(dir), '999999')
    expect(await claimDevInstance(dir, fakeDeps(() => false), 1000)).toBe(true)
  })

  it('waits for the previous instance to leave instead of giving up', async () => {
    const dir = newProfile()
    writeFileSync(pidFile(dir), '4242')
    let alive = true
    const deps = fakeDeps((pid) => pid === 4242 && alive, (tick) => {
      if (tick === 5) alive = false
    })
    expect(await claimDevInstance(dir, deps, 5000)).toBe(true)
    expect(readFileSync(pidFile(dir), 'utf8')).toBe(String(process.pid))
  })

  it('gives up only when the previous instance is still there after the wait', async () => {
    const dir = newProfile()
    writeFileSync(pidFile(dir), '4242')
    expect(await claimDevInstance(dir, fakeDeps(() => true), 500)).toBe(false)
    // it did not take the file over
    expect(readFileSync(pidFile(dir), 'utf8')).toBe('4242')
  })

  it('works against a real process: waits while it lives, goes on when it exits', async () => {
    const dir = newProfile()
    const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: 'ignore' })
    children.push(old)
    writeFileSync(pidFile(dir), String(old.pid))
    const started = Date.now()
    expect(await claimDevInstance(dir, undefined, 8000)).toBe(true)
    expect(Date.now() - started).toBeGreaterThan(300)
    expect(existsSync(pidFile(dir))).toBe(true)
  })
})

describe('claimInstance', () => {
  it('uses Electron\'s lock when packaged', async () => {
    expect(await claimInstance({ packaged: true, requestLock: () => false, profileDir: newProfile() })).toBe(false)
    expect(await claimInstance({ packaged: true, requestLock: () => true, profileDir: newProfile() })).toBe(true)
  })

  it('never asks Electron\'s lock in dev', async () => {
    let asked = false
    const owned = await claimInstance({
      packaged: false,
      requestLock: () => {
        asked = true
        return false
      },
      profileDir: newProfile(),
    })
    expect(owned).toBe(true)
    expect(asked).toBe(false)
  })
})
