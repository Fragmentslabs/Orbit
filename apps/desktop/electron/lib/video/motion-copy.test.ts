import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyPieceFolder } from './motion-copy'

const dirs: string[] = []
const tmp = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-copy-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  while (dirs.length) await fsp.rm(dirs.pop()!, { recursive: true, force: true })
})

describe('copyPieceFolder', () => {
  it('copies index, assets in subfolders, the audio manifest and the word times', async () => {
    const base = await tmp()
    const from = path.join(base, 'a')
    await fsp.mkdir(path.join(from, 'audio'), { recursive: true })
    await fsp.writeFile(path.join(from, 'index.html'), '<html></html>')
    await fsp.writeFile(path.join(from, 'audio.json'), '{"tracks":[]}')
    await fsp.writeFile(path.join(from, 'audio', 'nar.wav'), Buffer.from([1, 2, 3]))
    await fsp.writeFile(path.join(from, 'audio', 'nar.wav.words.json'), '{"words":[]}')
    const to = path.join(base, 'b')
    expect(await copyPieceFolder(from, to)).toBe(4)
    expect([...(await fsp.readFile(path.join(to, 'audio', 'nar.wav')))]).toEqual([1, 2, 3])
    expect(await fsp.readFile(path.join(to, 'audio.json'), 'utf8')).toBe('{"tracks":[]}')
    expect(await fsp.readFile(path.join(to, 'audio', 'nar.wav.words.json'), 'utf8')).toBe('{"words":[]}')
  })

  it('replaces a placeholder already in the target, and leaves the original alone', async () => {
    const base = await tmp()
    const from = path.join(base, 'a')
    const to = path.join(base, 'b')
    await fsp.mkdir(from)
    await fsp.mkdir(to)
    await fsp.writeFile(path.join(from, 'index.html'), 'real')
    await fsp.writeFile(path.join(to, 'index.html'), 'placeholder')
    await copyPieceFolder(from, to)
    expect(await fsp.readFile(path.join(to, 'index.html'), 'utf8')).toBe('real')
    expect(await fsp.readFile(path.join(from, 'index.html'), 'utf8')).toBe('real')
  })

  it('refuses itself and nesting', async () => {
    const base = await tmp()
    const from = path.join(base, 'a')
    await fsp.mkdir(from)
    await expect(copyPieceFolder(from, from)).rejects.toThrow(/onto itself/)
    await expect(copyPieceFolder(from, path.join(from, 'inside'))).rejects.toThrow(/inside the original/)
  })
})
