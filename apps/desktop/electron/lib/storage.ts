import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Simple file-based JSON storage, following opencode's pattern:
 * each key becomes a `<key>.json` file and the writing is atomic
 * (writes to a temporary file and renames).
 */

const KEY_SEGMENT = /^[a-zA-Z0-9_-]+$/

function storageDir() {
  return path.join(app.getPath('userData'), 'orbit-data', 'storage')
}

function fileFor(key: string) {
  const segments = key.split('/')
  for (const segment of segments) {
    if (!KEY_SEGMENT.test(segment)) throw new Error(`Invalid storage key: ${key}`)
  }
  return path.join(storageDir(), ...segments) + '.json'
}

export async function readJson<T>(key: string): Promise<T | null> {
  const file = fileFor(key)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    // One damaged file must not take the app down with it — the renderer reads
    // storage in its init, so a throw here leaves the whole window without events.
    // The file is moved aside (kept for inspection) and the key reads as empty;
    // the next write recreates it.
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
    console.error(`[storage] ${key}.json is not valid JSON — moved aside`, err)
    return null
  }
}

/**
 * Writes through a temporary sibling and renames it over the target.
 *
 * The temporary name must be unique per call. It used to be `<file>.<Date.now()>.tmp`,
 * so two writes of the same key within one millisecond shared the same temp: the
 * first rename carried the second write's bytes and the file was left with two JSON
 * documents stitched together (a torn `folders.json` broke the renderer's load).
 */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * Modification time and size of a key's file, without reading it — what a derived
 * index compares to know which entries changed. `null` when the key does not exist.
 */
export async function statKey(key: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const { mtimeMs, size } = await fs.stat(fileFor(key))
    return { mtimeMs, size }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  const file = fileFor(key)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeAtomic(file, JSON.stringify(value, null, 2))
}

export async function removeJson(key: string): Promise<void> {
  await fs.rm(fileFor(key), { force: true })
}

/**
 * Variant for raw text files (`.md`) — same key validation and
 * atomic writing as the JSON ones. Used by the attached memory documents,
 * which stay readable/editable outside the app.
 */
function textFileFor(key: string) {
  const segments = key.split('/')
  for (const segment of segments) {
    if (!KEY_SEGMENT.test(segment)) throw new Error(`Invalid storage key: ${key}`)
  }
  return path.join(storageDir(), ...segments) + '.md'
}

export async function readText(key: string): Promise<string | null> {
  try {
    return await fs.readFile(textFileFor(key), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeText(key: string, content: string): Promise<void> {
  const file = textFileFor(key)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeAtomic(file, content)
}

export async function removeText(key: string): Promise<void> {
  await fs.rm(textFileFor(key), { force: true })
}

/** Lists the existing keys under a prefix (e.g. "session/"). */
export async function listKeys(prefix: string): Promise<string[]> {
  const base = storageDir()
  const dir = path.join(base, ...prefix.split('/').filter(Boolean))
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => {
        const suffix = e.name.slice(0, -'.json'.length)
        return prefix ? `${prefix.replace(/\/?$/, '/')}${suffix}` : suffix
      })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** Root data directory of the app (auth, catalog cache, etc). */
export function dataDir() {
  return path.join(app.getPath('userData'), 'orbit-data')
}
