import fs, { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withAssetLock, writeFileAtomic } from './asset-lock'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orbit-asset-lock-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const key = (label: string) => `test:${label}:${Math.random().toString(36).slice(2)}`

describe('withAssetLock', () => {
  it('serializes work for the same key', async () => {
    const events: string[] = []
    const k = key('serial')
    const run = (label: string) =>
      withAssetLock(k, async () => {
        events.push(`${label}-start`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push(`${label}-end`)
      })

    await Promise.all([run('a'), run('b'), run('c')])
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end'])
  })

  it('lets a read-modify-write compose instead of losing an update', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'counter.txt')
    await writeFileAtomic(file, '0')
    const k = key('counter')
    const increment = () =>
      withAssetLock(k, async () => {
        const current = Number(await fs.readFile(file, 'utf8'))
        await new Promise((resolve) => setTimeout(resolve, 5))
        await writeFileAtomic(file, String(current + 1))
      })

    await Promise.all([increment(), increment(), increment()])
    expect(await fs.readFile(file, 'utf8')).toBe('3')
  })

  it('keeps running the queue after a failure', async () => {
    const k = key('failure')
    const results: string[] = []
    await Promise.all([
      withAssetLock(k, async () => {
        results.push('first')
        throw new Error('boom')
      }).catch(() => results.push('first-failed')),
      withAssetLock(k, async () => {
        results.push('second')
      }),
    ])
    expect(results).toEqual(['first', 'first-failed', 'second'])
  })

  it('does not serialize different keys', async () => {
    let active = 0
    let maxActive = 0
    const run = () =>
      withAssetLock(key('independent'), async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
      })

    await Promise.all([run(), run()])
    expect(maxActive).toBe(2)
  })
})

describe('writeFileAtomic', () => {
  it('writes the content and leaves no temp file behind', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'nested', 'file.txt')
    await writeFileAtomic(file, 'hello')
    expect(await fs.readFile(file, 'utf8')).toBe('hello')
    const entries = await fs.readdir(path.dirname(file))
    expect(entries).toEqual(['file.txt'])
  })

  it('overwrites an existing file', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'file.txt')
    await writeFileAtomic(file, 'one')
    await writeFileAtomic(file, 'two')
    expect(await fs.readFile(file, 'utf8')).toBe('two')
  })
})
