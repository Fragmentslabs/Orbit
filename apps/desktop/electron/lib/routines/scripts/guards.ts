import fs from 'node:fs'
import path from 'node:path'

/**
 * What a script is allowed to touch, decided in the main process: the script only ever sees
 * the results. Pure functions, so the rules are tested without running anything.
 */

/** https only; the host (or a parent domain of it) must be listed. */
export function checkFetchUrl(rawUrl: string, hosts: readonly string[]): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: `Not a valid URL: ${rawUrl.slice(0, 80)}` }
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'Only https addresses can be fetched.' }
  const host = url.hostname.toLowerCase()
  const allowed = hosts.some((h) => {
    const listed = h.trim().toLowerCase()
    return listed !== '' && (host === listed || host.endsWith(`.${listed}`))
  })
  if (!allowed) return { ok: false, error: `The script did not declare the host ${host}.` }
  return { ok: true, url }
}

/** Only harmless request headers go through: no cookies, no credentials. */
const SAFE_HEADERS = new Set(['accept', 'accept-language', 'user-agent'])

export function safeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (SAFE_HEADERS.has(key.toLowerCase()) && typeof value === 'string') out[key] = value.slice(0, 200)
  }
  return out
}

/**
 * Resolves a path a script asked for to a real path inside one of the routine's folders. A
 * relative path is read from the first folder. Symlinks are resolved first, so a link pointing
 * outside the folder does not get through.
 */
export function resolveInsideFolders(requested: string, folders: readonly string[]): { ok: true; path: string } | { ok: false; error: string } {
  if (folders.length === 0) return { ok: false, error: 'This routine has no folder the script may read.' }
  const target = path.resolve(folders[0], requested)
  let real: string
  try {
    real = fs.realpathSync(target)
  } catch {
    return { ok: false, error: `Not found: ${requested.slice(0, 120)}` }
  }
  for (const folder of folders) {
    let root: string
    try {
      root = fs.realpathSync(folder)
    } catch {
      continue
    }
    if (real === root || real.startsWith(root + path.sep)) return { ok: true, path: real }
  }
  return { ok: false, error: 'The script may only read inside the routine folders.' }
}
