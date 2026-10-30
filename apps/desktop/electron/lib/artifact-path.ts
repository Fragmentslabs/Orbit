import path from 'node:path'

/**
 * Resolves an artifact's name (saved by orbit.save) inside the output
 * folder, refusing any path that escapes it. Separated from browser-script
 * to be testable without Electron.
 */
export function resolveArtifactPath(base: string, name: string): string {
  const normalized = String(name ?? '').replace(/\\/g, '/')
  if (!normalized.trim()) throw new Error('Artifact name is required')
  // Absolute (unix or windows) is not an artifact name — it rejects at the entrance.
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`Artifact path must be relative: ${name}`)
  }
  const root = path.resolve(base)
  const target = path.resolve(root, normalized)
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Artifact path escapes the output folder: ${name}`)
  }
  return target
}
