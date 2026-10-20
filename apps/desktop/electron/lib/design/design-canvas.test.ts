import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isSafeBoardFile, readDesignCanvas, writeDesignCanvas, type DesignCanvas } from './design-canvas'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orbit-design-canvas-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('isSafeBoardFile', () => {
  it('accepts a plain name ending in .html/.htm', () => {
    expect(isSafeBoardFile('Main.html')).toBe(true)
    expect(isSafeBoardFile('index.htm')).toBe(true)
    expect(isSafeBoardFile('a.html')).toBe(true)
  })

  it('rejects paths, traversal and anything not ending in .html', () => {
    expect(isSafeBoardFile('../escape.html')).toBe(false)
    expect(isSafeBoardFile('sub/Main.html')).toBe(false)
    expect(isSafeBoardFile('Main.js')).toBe(false)
    expect(isSafeBoardFile('')).toBe(false)
    expect(isSafeBoardFile('.html')).toBe(false)
  })
})

describe('writeDesignCanvas / readDesignCanvas', () => {
  it('round-trips the index', async () => {
    const folder = await tempDir()
    const canvas: DesignCanvas = {
      v: 1,
      title: 'Landing page',
      boards: { 'Main.html': { title: 'Hero', x: 0, y: 0, w: 1280, h: 800 } },
      order: ['Main.html'],
    }
    await writeDesignCanvas(folder, canvas)
    const back = await readDesignCanvas(folder)
    expect(back).toEqual(canvas)
  })

  it('throws on a malformed index', async () => {
    const folder = await tempDir()
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'canvas.json'), JSON.stringify({ foo: 'bar' }), 'utf8')
    await expect(readDesignCanvas(folder)).rejects.toThrow(/malformado/)
  })
})
