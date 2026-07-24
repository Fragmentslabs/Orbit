import fsp from 'node:fs/promises'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { globalSkillsDir } from './index'
import { parseSkill } from './parser'

/**
 * Importação de skills. Dois formatos aceitos:
 * 1. Texto: arquivo .skill/.md com frontmatter (+ arquivos extras selecionados
 *    juntos, que viram o bundle).
 * 2. ZIP (formato dos .skill exportados pelo Claude): arquivo com magic "PK"
 *    contendo SKILL.md + scripts — extraído como bundle, preservando a
 *    estrutura relativa à pasta do manifesto.
 */

export interface ImportResult {
  imported: boolean
  slug?: string
  error?: string
}

const TEXT_EXTENSIONS = new Set(['.skill', '.md'])

function isZip(buffer: Buffer): boolean {
  return buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b
}

/** Impede que entradas do zip escapem da pasta destino (path traversal). */
function safeJoin(base: string, relative: string): string | null {
  const resolved = path.resolve(base, relative)
  const rel = path.relative(base, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return resolved
}

async function writeFlatOrBundle(
  slug: string,
  manifestRaw: string,
  extras: Array<{ relPath: string; data: Uint8Array }>,
): Promise<void> {
  const dir = globalSkillsDir()
  await fsp.mkdir(dir, { recursive: true })
  if (extras.length === 0) {
    await fsp.writeFile(path.join(dir, `${slug}.skill`), manifestRaw, 'utf8')
    return
  }
  const bundle = path.join(dir, slug)
  await fsp.rm(bundle, { recursive: true, force: true })
  await fsp.mkdir(bundle, { recursive: true })
  await fsp.writeFile(path.join(bundle, 'skill.md'), manifestRaw, 'utf8')
  for (const extra of extras) {
    const target = safeJoin(bundle, extra.relPath)
    if (!target) continue // entrada maliciosa/inválida — pula
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, extra.data)
  }
}

function importZip(buffer: Buffer): Promise<ImportResult> | ImportResult {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(buffer))
  } catch {
    return { imported: false, error: 'Arquivo ZIP inválido ou corrompido.' }
  }
  const names = Object.keys(entries).filter((n) => !n.endsWith('/'))

  // Manifesto: SKILL.md (qualquer caixa), o menos aninhado quando houver vários
  const manifestName = names
    .filter((n) => n.split('/').pop()?.toLowerCase() === 'skill.md')
    .sort((a, b) => a.split('/').length - b.split('/').length)[0]
  if (!manifestName) {
    return { imported: false, error: 'O pacote não contém um SKILL.md — não é uma skill válida.' }
  }

  const raw = strFromU8(entries[manifestName])
  const parsed = parseSkill(raw, 'global', manifestName)
  if (!parsed) {
    return { imported: false, error: 'SKILL.md sem frontmatter válido (---\nname: …\n---).' }
  }

  // Caminhos relativos à pasta do manifesto (remove o diretório raiz do zip)
  const rootPrefix = manifestName.includes('/')
    ? manifestName.slice(0, manifestName.lastIndexOf('/') + 1)
    : ''
  const extras = names
    .filter((n) => n !== manifestName)
    .map((n) => ({
      relPath: n.startsWith(rootPrefix) ? n.slice(rootPrefix.length) : n,
      data: entries[n],
    }))

  return writeFlatOrBundle(parsed.slug, raw, extras).then(() => ({
    imported: true,
    slug: parsed.slug,
  }))
}

/** Lê um anexo de chat que pode ser uma skill (.skill texto/ZIP, ou .md com
 * frontmatter de skill) e devolve uma descrição textual para o agente — NÃO
 * grava nada em disco (isso só acontece via create_skill + aprovação no card).
 * Retorna null quando o conteúdo não é uma skill válida (ex.: .md comum). */
export function describeSkillAttachment(buffer: Buffer, filename?: string): string | null {
  if (isZip(buffer)) {
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(buffer))
    } catch {
      return null
    }
    const names = Object.keys(entries).filter((n) => !n.endsWith('/'))
    const manifestName = names
      .filter((n) => n.split('/').pop()?.toLowerCase() === 'skill.md')
      .sort((a, b) => a.split('/').length - b.split('/').length)[0]
    if (!manifestName) return null
    const raw = strFromU8(entries[manifestName])
    const parsed = parseSkill(raw, 'global', manifestName)
    if (!parsed) return null
    const extras = names.filter((n) => n !== manifestName)
    return [
      `Nome: ${parsed.name}`,
      `Descrição: ${parsed.description}`,
      extras.length ? `Arquivos auxiliares: ${extras.join(', ')}` : '',
      '',
      parsed.content,
    ]
      .filter(Boolean)
      .join('\n')
  }

  let raw: string
  try {
    raw = buffer.toString('utf8')
  } catch {
    return null
  }
  const parsed = parseSkill(raw, 'global', filename ?? 'attachment.skill')
  if (!parsed) return null
  return [`Nome: ${parsed.name}`, `Descrição: ${parsed.description}`, '', parsed.content].join('\n')
}

/** Importa a seleção do dialog (arquivo zip OU manifesto texto + extras). */
export async function importSkillSelection(filePaths: string[]): Promise<ImportResult> {
  if (filePaths.length === 0) return { imported: false }

  const manifestPath = filePaths.find((p) => TEXT_EXTENSIONS.has(path.extname(p).toLowerCase()))
  if (!manifestPath) {
    return { imported: false, error: 'Selecione um arquivo .skill ou .md (o manifesto da skill).' }
  }

  const buffer = await fsp.readFile(manifestPath)
  // .skill do Claude é um ZIP (bundle SKILL.md + scripts)
  if (isZip(buffer)) return importZip(buffer)

  const raw = buffer.toString('utf8')
  const parsed = parseSkill(raw, 'global', manifestPath)
  if (!parsed) {
    return { imported: false, error: 'Arquivo sem frontmatter válido (---\nname: …\n---).' }
  }
  const extras = await Promise.all(
    filePaths
      .filter((p) => p !== manifestPath)
      .map(async (p) => ({ relPath: path.basename(p), data: new Uint8Array(await fsp.readFile(p)) })),
  )
  await writeFlatOrBundle(parsed.slug, raw, extras)
  return { imported: true, slug: parsed.slug }
}
