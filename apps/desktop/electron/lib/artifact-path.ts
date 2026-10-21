import path from 'node:path'

/**
 * Resolve o nome de um artefato (salvo por orbit.save) dentro da pasta de
 * saída, recusando qualquer caminho que fuja dela. Separado do browser-script
 * para ser testável sem Electron.
 */
export function resolveArtifactPath(base: string, name: string): string {
  const normalized = String(name ?? '').replace(/\\/g, '/')
  if (!normalized.trim()) throw new Error('Artifact name is required')
  // Absoluto (unix ou windows) não é um nome de artefato — rejeita na entrada.
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
