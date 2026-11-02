import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Cloning a composition: the WHOLE folder, not just index.html. A clone made by rewriting the
 * html comes out mute and with broken images — the assets (audio files, photos, fonts), the
 * audio.json that places them and the word times next to each narration are separate files.
 */

export const MAX_COPY_BYTES = 1024 * 1024 * 1024
export const MAX_COPY_FILES = 400

async function scan(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = await scan(full)
      files += inner.files
      bytes += inner.bytes
    } else if (entry.isFile()) {
      files++
      bytes += (await fsp.stat(full)).size
    }
  }
  return { files, bytes }
}

/** Copies every file of `from` into `to` (created if needed; same-named files are replaced). Returns how many. */
export async function copyPieceFolder(from: string, to: string): Promise<number> {
  const source = path.resolve(from)
  const target = path.resolve(to)
  if (source === target) throw new Error('a composition cannot be cloned onto itself')
  if (target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) {
    throw new Error('the clone cannot sit inside the original (or the other way around)')
  }
  const { files, bytes } = await scan(source)
  if (files > MAX_COPY_FILES) throw new Error(`the composition has ${files} files; the clone limit is ${MAX_COPY_FILES}`)
  if (bytes > MAX_COPY_BYTES) throw new Error('the composition is larger than the clone limit')
  await fsp.mkdir(target, { recursive: true })
  // Symlinks are not followed: the piece's folder holds files, and a link out of it is not ours to copy.
  await fsp.cp(source, target, { recursive: true, force: true, dereference: false })
  return files
}
