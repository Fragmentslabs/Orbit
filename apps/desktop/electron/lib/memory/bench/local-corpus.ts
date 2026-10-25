/**
 * Acesso ao acervo real de memórias e ao índice de vetores persistido.
 *
 * Existe para que os runners locais (revisão por página e avaliação por JSON)
 * compartilhem a mesma leitura. NADA aqui imprime texto de memória: quem chama
 * recebe os objetos e decide o que fazer com eles.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Memory } from '@shared/memory'

/** Pasta local de trabalho da revisão. Fica fora do repositório, de propósito. */
export const OUT = process.env.MEMORY_REVIEW_DIR
  ? path.resolve(process.env.MEMORY_REVIEW_DIR)
  : path.join(os.homedir(), '.orbit-memory-review')

/** Onde o app guarda as memórias do usuário no macOS. */
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
 * Lê todas as memórias do usuário.
 *
 * Memórias `core` ficam de fora: elas já entram no bloco fixo do prompt e não
 * são candidatas a recuperação.
 */
export function readMemories(): Memory[] {
  const dir = itemsDir()
  if (!fs.existsSync(dir)) return []
  const out: Memory[] = []
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    // Um arquivo pode conter um objeto ou um array de memórias.
    for (const m of Array.isArray(raw) ? raw : [raw]) {
      if (m && typeof m.id === 'string' && typeof m.text === 'string' && m.kind !== 'core') out.push(m as Memory)
    }
  }
  return out
}

/** Onde ficam os documentos markdown anexados às memórias. */
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

/** Documentos anexados, por id de memória. Vazio se a pasta não existir. */
export function readDocs(): Map<string, string> {
  const dir = docsDir()
  const out = new Map<string, string>()
  if (!fs.existsSync(dir)) return out
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    try {
      out.set(path.basename(file, '.md'), fs.readFileSync(path.join(dir, file), 'utf8'))
    } catch {
      /* documento ilegível: fica de fora da medição */
    }
  }
  return out
}

/** Caminho do índice de vetores que o app persiste. */
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

/** Decodifica um vetor Float32 gravado em base64. */
export function decode(b64: string): Float32Array | null {
  try {
    const buf = Buffer.from(b64, 'base64')
    if (buf.byteLength % 4 !== 0) return null
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  } catch {
    return null
  }
}

/** Vetores persistidos, por id de memória. Vazio se o índice não existir. */
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
    /* índice ilegível: devolve o que der */
  }
  return out
}
