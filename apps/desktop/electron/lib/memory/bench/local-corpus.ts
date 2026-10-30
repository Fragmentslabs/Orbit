/**
 * Access to the real memory pool and to the persisted vector index.
 *
 * It exists so the local runners (page review and JSON evaluation)
 * share the same reading. NOTHING here prints memory text: the caller
 * receives the objects and decides what to do with them.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Memory } from '@shared/memory'

/** Local working folder of the review. It stays outside the repository, on purpose. */
export const OUT = process.env.MEMORY_REVIEW_DIR
  ? path.resolve(process.env.MEMORY_REVIEW_DIR)
  : path.join(os.homedir(), '.orbit-memory-review')

/** Where the app keeps the user's memories on macOS. */
export function itemsDir(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    '@orbit',
    'desktop',
    'orbit-data',
    'storage',
    'memory',
    'items',
  )
}

/**
 * Reads all of the user's memories.
 *
 * `core` memories stay out: they already enter the fixed prompt block and are
 * not retrieval candidates.
 */
export function readMemories(): Memory[] {
  const dir = itemsDir()
  if (!fs.existsSync(dir)) return []
  const out: Memory[] = []
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    // A file may contain one object or an array of memories.
    for (const m of Array.isArray(raw) ? raw : [raw]) {
      if (m && typeof m.id === 'string' && typeof m.text === 'string' && m.kind !== 'core') out.push(m as Memory)
    }
  }
  return out
}

/** Where the markdown documents attached to memories live. */
export function docsDir(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    '@orbit',
    'desktop',
    'orbit-data',
    'storage',
    'memory',
    'docs',
  )
}

/** Attached documents, by memory id. Empty if the folder does not exist. */
export function readDocs(): Map<string, string> {
  const dir = docsDir()
  const out = new Map<string, string>()
  if (!fs.existsSync(dir)) return out
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    try {
      out.set(path.basename(file, '.md'), fs.readFileSync(path.join(dir, file), 'utf8'))
    } catch {
      /* unreadable document: it stays out of the measurement */
    }
  }
  return out
}

/** Path of the vector index the app persists. */
export function vectorsPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    '@orbit',
    'desktop',
    'orbit-data',
    'storage',
    'memory',
    'vectors.json',
  )
}

/** Decodes a Float32 vector stored in base64. */
export function decode(b64: string): Float32Array | null {
  try {
    const buf = Buffer.from(b64, 'base64')
    if (buf.byteLength % 4 !== 0) return null
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  } catch {
    return null
  }
}

/** Persisted vectors, by memory id. Empty if the index does not exist. */
export function readVectors(): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  const file = vectorsPath()
  if (!fs.existsSync(file)) return out
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      items?: Record<string, { vec?: string }>
    }
    for (const [id, item] of Object.entries(payload.items ?? {})) {
      const vec = item?.vec ? decode(item.vec) : null
      if (vec) out.set(id, vec)
    }
  } catch {
    /* unreadable index: return what we can */
  }
  return out
}
