import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Memory, MemoryKind, ProjectCategory } from '@shared/memory'
import { normalizeText } from '@shared/memory'

/**
 * Regras puras do sistema de memória (zero I/O): identificação de projeto,
 * expiração, promoção automática e hashing de dedup. Testável sem Electron.
 */

const DAY = 24 * 60 * 60 * 1000

/** TTL base de memórias que expiram (seasonal e project/context). */
const BASE_TTL = 30 * DAY

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/**
 * Identidade estável de um projeto a partir do directory. No Windows os paths
 * são case-insensitive, então normalizamos para lowercase completo — só a
 * letra do drive ainda deixaria "C:/Projects" e "C:/projects" duplicados.
 */
export function projectIdOf(directory: string): string {
  return sha1(normalizeDirectory(directory))
}

/** Pasta na forma em que projetos são comparados: absoluta, com "/", sem barra final e, no Windows, minúscula. */
export function normalizeDirectory(directory: string): string {
  const normalized = path.resolve(directory).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export interface ProjectRoot {
  projectId: string
  /** Pasta como foi gravada na memória raiz — é a que vira `directory` de novas memórias. */
  directory: string
}

/**
 * Projeto que cobre uma pasta: ela mesma, ou a pasta acima mais próxima que já
 * tem árvore de memórias.
 *
 * O /init roda na pasta mãe ("app/", com "front/" e "backend/" dentro) e grava
 * tudo sob o projectId dela. Sem esta subida, um chat aberto direto em
 * "app/front" calculava o projectId de "front", não achava nada e começava do
 * zero — exatamente o contexto que o /init existe para não pedir de novo.
 *
 * `subproject` é o caminho relativo até a pasta pedida ("front", "front/src"),
 * em "/" e com a caixa original; undefined quando a pasta é a própria raiz.
 */
export function pickProjectRoot(
  roots: ProjectRoot[],
  directory: string,
): { root: ProjectRoot; subproject?: string } | null {
  const target = normalizeDirectory(directory)
  let best: { root: ProjectRoot; normalized: string } | null = null
  for (const root of roots) {
    const normalized = normalizeDirectory(root.directory)
    const covers = target === normalized || target.startsWith(`${normalized}/`)
    if (covers && (!best || normalized.length > best.normalized.length)) best = { root, normalized }
  }
  if (!best) return null
  if (target === best.normalized) return { root: best.root }
  // O relativo sai do caminho real (não do normalizado) para manter a caixa
  // com que a pasta existe — é o que aparece no rótulo do subprojeto.
  const relative = path.relative(path.resolve(best.root.directory), path.resolve(directory)).replace(/\\/g, '/')
  return { root: best.root, subproject: relative || undefined }
}

/** `child` é `scope` ou fica dentro dele ("front/src" está em "front"; "frontend" não). Sem caixa. */
export function isWithinSubproject(child: string, scope: string): boolean {
  const c = child.toLowerCase().replace(/\/+$/, '')
  const s = scope.toLowerCase().replace(/\/+$/, '')
  return c === s || c.startsWith(`${s}/`)
}

/** Hash do texto normalizado — chave de dedup exata. */
export function hashText(text: string): string {
  return sha1(normalizeText(text))
}

/**
 * TTL por tipo: seasonal e project/context expiram em 30d × (1 + weight × 6);
 * os demais tipos são permanentes (null).
 */
export function ttlFor(kind: MemoryKind, weight: number, category?: ProjectCategory): number | null {
  const expires = kind === 'seasonal' || (kind === 'project' && category === 'context')
  if (!expires) return null
  return Math.round(BASE_TTL * (1 + weight * 6))
}

/**
 * Cada hit de busca estende a expiração levemente (+7d), com teto de 2× o TTL
 * original a partir da criação — memórias usadas vivem mais, mas não para sempre.
 */
export function extendedExpiry(memory: Memory): number | null | undefined {
  if (memory.expiresAt == null) return memory.expiresAt
  const ttl = ttlFor(memory.kind, memory.weight, memory.category)
  if (ttl == null) return null
  const cap = memory.createdAt + 2 * ttl
  return Math.min(memory.expiresAt + 7 * DAY, cap)
}

export function isExpired(memory: Memory, now: number): boolean {
  return memory.expiresAt != null && memory.expiresAt < now
}

export interface Promotion {
  kind: MemoryKind
  category?: ProjectCategory
}

/**
 * Promoção 100% automática (aplicada pelo scheduler):
 * - seasonal → core quando hits >= 5 OU weight >= 0.85
 * - project/context → decision quando hits >= 3 e ainda não expirou
 * Retorna o destino da promoção ou null.
 */
export function shouldPromote(memory: Memory, now: number): Promotion | null {
  if (isExpired(memory, now)) return null
  if (memory.kind === 'seasonal' && (memory.hits >= 5 || memory.weight >= 0.85)) {
    return { kind: 'core' }
  }
  if (memory.kind === 'project' && memory.category === 'context' && memory.hits >= 3) {
    return { kind: 'project', category: 'decision' }
  }
  return null
}

/** Peso default quando o agente não informa: baixo para o que expira, alto para o resto. */
export function defaultWeight(kind: MemoryKind, category?: ProjectCategory): number {
  return kind === 'seasonal' || (kind === 'project' && category === 'context') ? 0.3 : 0.7
}
