import path from 'node:path'

/** Contexto passado a todas as ferramentas de uma execução. */
export interface ToolContext {
  sessionId: string
  /** Pasta principal de trabalho */
  directory: string
  /** Pastas adicionais anexadas pelo usuário */
  extraDirectories: string[]
  abort: AbortSignal
}

export class PathAccessError extends Error {}

/**
 * Resolve um caminho relativo à pasta principal e garante que o resultado
 * esteja dentro de uma das pastas permitidas (principal ou anexadas) —
 * mesma proteção que o opencode aplica em external-directory.
 */
export function resolveSafePath(ctx: ToolContext, target: string): string {
  const resolved = path.resolve(ctx.directory, target)
  const roots = [ctx.directory, ...ctx.extraDirectories]
  const allowed = roots.some((root) => {
    const rel = path.relative(path.resolve(root), resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
  if (!allowed) {
    throw new PathAccessError(
      `Acesso negado: ${resolved} está fora das pastas de trabalho (${roots.join(', ')})`,
    )
  }
  return resolved
}

export const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', '.next', 'build', 'out', '.turbo', '.cache'])
