import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Concurrency between chats/tools on the SAME resource.
 *
 * The main is a single process, so an in-memory queue per key is enough for
 * two edits (from different chats, or from the agent and the UI's editor) not to
 * interleave reading and writing the same file. The key is the composition's/canvas's
 * FOLDER — since an edit touches more than one file at a time
 * (canvas.json + artboards, index.html + assets) — or the artifact's id.
 *
 * Combined with writeFileAtomic, the file is never left half-written; and since the
 * reading of an edit happens INSIDE the lock, an outdated edit fails (the
 * oldText does not match) instead of overwriting the other chat's work.
 */
const queues = new Map<string, Promise<unknown>>()

export function withAssetLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, tail)
  void tail.finally(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

/** Writes via tmp + rename: a crash in the middle never leaves the file half-written. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await fsp.writeFile(tmp, data)
  try {
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}
