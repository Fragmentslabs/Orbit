import fsp from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { getMotion, registerMotion } from './motion-store'
import { piecesDir, pieceSlug } from '../tools/piece-paths'

/**
 * O PROJETO de uma composição: a pasta inteira num `.zip`, e a volta.
 *
 * Uma peça de motion é uma pasta do app — o HTML, as mídias que entraram, as
 * fontes, o `audio.json`. Ela não sai de lá sozinha: o render entrega o VÍDEO,
 * nunca a peça. Sem isto, levar uma composição de uma conversa para outra (ou
 * guardá-la antes de limpar o disco) era copiar arquivos à mão.
 *
 * O `.zip` carrega um manifesto `orbit.json` na raiz — é o que faz um arquivo
 * renomeado continuar sendo reconhecido como peça, e não como um zip qualquer.
 * Na volta, nada é sobrescrito: a peça importada nasce com id novo numa pasta
 * nova, e o mesmo zip pode ser importado quantas vezes se quiser, cada vez como
 * uma peça independente.
 */

export const MOTION_PROJECT_MANIFEST = 'orbit.json'

/** Versão do formato. Um zip de versão futura é recusado com o motivo. */
export const MOTION_PROJECT_VERSION = 1

/**
 * Teto do zip: acima disto a importação pelo chat fica cara (o arquivo viaja
 * como anexo) e é mais honesto recusar do que arrastar a conversa por minutos.
 */
export const MAX_PROJECT_ZIP_BYTES = 256 * 1024 * 1024
/** Teto do que sai do zip (proteção contra bomba de descompressão). */
export const MAX_PROJECT_BYTES = 1024 * 1024 * 1024
/** Teto inútil de propósito: nenhuma peça tem isso de arquivos. */
export const MAX_PROJECT_FILES = 400

export interface MotionProjectManifest {
  kind: 'orbit-motion-project'
  version: number
  name: string
  createdAt: number
  entry: string
  /** O formato declarado na composição, para quem quiser saber antes de abrir. */
  format: { width?: number; height?: number; fps?: number; durationInFrames?: number } | null
  /** Os arquivos que o zip leva, relativo à raiz dele (o manifesto inclusive). */
  files: string[]
}

/** Extensões que viajam comprimidas; mídia já é comprimida e vai armazenada. */
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.srt', '.vtt'])
const MAX_DEPTH = 4

/** `<meta name="orbit-motion" content="width=…,fps=…,duration=…">` → formato. */
export function motionFormatOf(html: string): MotionProjectManifest['format'] {
  const tag = /<meta\s+name=["']orbit-motion["']\s+content=["']([^"']*)["']/i.exec(html)
  if (!tag) return null
  const spec: { width?: number; height?: number; fps?: number; durationInFrames?: number } = {}
  for (const pair of tag[1].split(/[,;]/)) {
    const [key, raw] = pair.split('=').map((value) => value.trim())
    const num = Number(raw)
    if (!Number.isFinite(num) || num <= 0) continue
    if (key === 'width' || key === 'height' || key === 'fps') spec[key] = num
    if (key === 'duration') spec.durationInFrames = Math.round(num * (spec.fps ?? 30))
  }
  return Object.keys(spec).length ? spec : null
}

/** Nome relativo à pasta, com `/`, sem escapar dela. */
function relativeName(root: string, target: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/** Os arquivos da pasta da peça (todos — o zip leva a peça inteira). */
async function listProjectFiles(
  root: string,
  dir = root,
  depth = 0,
  out: string[] = [],
): Promise<string[]> {
  if (depth > MAX_DEPTH || out.length >= MAX_PROJECT_FILES) return out
  let items: Dirent[]
  try {
    items = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const item of items) {
    if (out.length >= MAX_PROJECT_FILES) break
    // `.motion-*` é o temporário do editor, `.DS_Store` é do Finder: nada disso
    // é a peça.
    if (item.name.startsWith('.')) continue
    const abs = path.join(dir, item.name)
    if (item.isDirectory()) {
      await listProjectFiles(root, abs, depth + 1, out)
      continue
    }
    if (!item.isFile()) continue
    // Sempre relativo à RAIZ da peça (`fonts/inter.woff2`), inclusive nas
    // subpastas — é esse caminho que o zip guarda e que o import recria.
    const rel = relativeName(root, abs)
    if (rel) out.push(rel)
  }
  return out
}

/**
 * Monta o `.zip` da composição: pasta inteira + `orbit.json` na raiz.
 *
 * O manifesto é escrito NA HORA (nunca o que estiver em disco), para o nome e o
 * formato estarem sempre de acordo com a peça que está sendo exportada.
 */
export async function exportMotionProject(id: string): Promise<{ buffer: Buffer; name: string; files: number }> {
  const entry = await getMotion(id)
  if (!entry) throw new Error('this composition is no longer registered — open it again before saving the project')
  const folder = entry.folder
  const stats = await fsp.stat(folder).catch(() => null)
  if (!stats?.isDirectory()) throw new Error(`the composition folder is gone: ${folder}`)

  const names = await listProjectFiles(folder)
  if (!names.length) throw new Error('the composition folder is empty')
  const archive: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
  let bytes = 0
  for (const name of names) {
    const abs = path.join(folder, name)
    const data = await fsp.readFile(abs).catch(() => null)
    if (!data) continue
    bytes += data.byteLength
    const level = TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) ? 6 : 0
    archive[name] = [new Uint8Array(data), { level }]
  }
  const entryName = relativeName(folder, entry.entry) ?? 'index.html'
  if (!archive[entryName]) throw new Error(`the composition entry is missing: ${entryName}`)
  const html = await fsp.readFile(entry.entry, 'utf8').catch(() => '')
  const manifest: MotionProjectManifest = {
    kind: 'orbit-motion-project',
    version: MOTION_PROJECT_VERSION,
    name: path.basename(folder),
    createdAt: Date.now(),
    entry: entryName,
    format: motionFormatOf(html),
    files: [MOTION_PROJECT_MANIFEST, ...Object.keys(archive).sort()],
  }
  archive[MOTION_PROJECT_MANIFEST] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }]
  const buffer = Buffer.from(zipSync(archive, { level: 6 }))
  return { buffer, name: `${manifest.name}.zip`, files: manifest.files.length }
}

/** O que o zip declara, sem descomprimir mídia nenhuma. */
interface ZipScan {
  /** Nome de cada entrada de arquivo (sem as de diretório). */
  names: string[]
  /** Soma declarada do conteúdo descomprimido. */
  bytes: number
}

/**
 * Lê o DIRETÓRIO do zip (nomes e tamanhos declarados), sem inflar o conteúdo.
 *
 * É o que permite recusar uma bomba de descompressão antes de ela acontecer: o
 * tamanho original vem no cabeçalho e o `filter` do fflate decide entrada por
 * entrada, antes do inflate.
 */
function scanZip(data: Uint8Array): ZipScan {
  const names: string[] = []
  let bytes = 0
  unzipSync(data, {
    filter: (file) => {
      if (!file.name.endsWith('/')) {
        names.push(file.name)
        bytes += file.originalSize ?? 0
      }
      return false
    },
  })
  return { names, bytes }
}

/** É um zip? (assinatura, como a importação de skills.) */
export function isZip(buffer: Buffer | Uint8Array): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
}

/**
 * O manifesto de um zip de peça, ou `null` quando o arquivo não é um projeto de
 * motion. É a pergunta que o chat faz em todo anexo `.zip` antes de decidir o
 * que fazer com ele — um zip comum segue o caminho de anexo de sempre.
 */
export function readMotionProject(buffer: Buffer): MotionProjectManifest | null {
  if (!isZip(buffer)) return null
  const data = new Uint8Array(buffer)
  let scan: ZipScan
  try {
    scan = scanZip(data)
  } catch {
    return null
  }
  const manifestName = scan.names
    .filter((name) => {
      const clean = name.replace(/\\/g, '/')
      return clean.split('/').pop()?.toLowerCase() === MOTION_PROJECT_MANIFEST
    })
    .sort((a, b) => a.split('/').length - b.split('/').length)[0]
  if (!manifestName) return null
  let raw: string
  try {
    const entries = unzipSync(data, { filter: (file) => file.name === manifestName })
    raw = strFromU8(entries[manifestName])
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MotionProjectManifest>
    if (parsed.kind !== 'orbit-motion-project') return null
    if (typeof parsed.version !== 'number' || parsed.version > MOTION_PROJECT_VERSION) return null
    if (typeof parsed.entry !== 'string' || !parsed.entry.trim()) return null
    return {
      kind: 'orbit-motion-project',
      version: parsed.version,
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'motion',
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      entry: parsed.entry,
      format: parsed.format ?? null,
      files: Array.isArray(parsed.files) ? parsed.files.filter((f): f is string => typeof f === 'string') : [],
    }
  } catch {
    return null
  }
}

/**
 * Caminho relativo SEGURO de uma entrada do zip. Devolve `null` para o que
 * tentaria escapar da pasta (absoluto, `..`, nome vazio) ou não é arquivo da
 * peça (lixo do sistema, o próprio manifesto).
 */
export function safeZipEntry(rootPrefix: string, name: string): string | null {
  const clean = name.replace(/\\/g, '/')
  if (!clean.startsWith(rootPrefix)) return null
  const rel = clean.slice(rootPrefix.length)
  if (!rel || rel.endsWith('/')) return null
  if (rel.startsWith('/') || path.isAbsolute(rel)) return null
  const segments = rel.split('/')
  if (segments.some((part) => !part || part === '.' || part === '..')) return null
  const base = segments[segments.length - 1]
  if (base.startsWith('.') || segments[0] === '__MACOSX') return null
  if (segments.length === 1 && base.toLowerCase() === MOTION_PROJECT_MANIFEST) return null
  if (segments.length > MAX_DEPTH + 1) return null
  return rel
}

/** Primeira pasta livre com aquele nome (`intro`, `intro-2`, `intro-3`…). */
async function uniqueFolder(root: string, name: string): Promise<string> {
  for (let attempt = 1; attempt < 200; attempt++) {
    const folder = path.join(root, attempt === 1 ? name : `${name}-${attempt}`)
    const exists = await fsp.stat(folder).then(() => true).catch(() => false)
    if (!exists) return folder
  }
  throw new Error('too many compositions with this name — rename the project before importing')
}

export interface ImportedMotionProject {
  id: string
  /** Nome da peça (a pasta), que é como as tools a chamam na conversa. */
  name: string
  folder: string
  entry: string
  files: number
  bytes: number
  /** Quantos arquivos declarados no zip não entraram (lixo do sistema). */
  skipped: number
}

/**
 * Recria a peça a partir do zip, numa pasta NOVA desta conversa.
 *
 * Nada é sobrescrito: o nome ganha sufixo quando já existe (`intro-2`) e o id
 * nasce da pasta nova, então importar o mesmo zip duas vezes dá duas peças
 * independentes — que é o que se espera de "importar".
 */
export async function importMotionProject(
  buffer: Buffer,
  opts: { sessionId: string },
): Promise<ImportedMotionProject> {
  if (buffer.byteLength > MAX_PROJECT_ZIP_BYTES) {
    throw new Error(
      `the .zip is too large to import through the chat (${Math.round(buffer.byteLength / 1024 / 1024)} MB; the limit is ${MAX_PROJECT_ZIP_BYTES / 1024 / 1024} MB)`,
    )
  }
  const manifest = readMotionProject(buffer)
  if (!manifest) throw new Error(`the .zip is not a motion project (no ${MOTION_PROJECT_MANIFEST} at the root)`)
  const data = new Uint8Array(buffer)
  const scan = scanZip(data)
  // Antes de inflar QUALQUER coisa: o cabeçalho já diz o tamanho descomprimido,
  // e é aqui que uma bomba de descompressão é recusada.
  if (scan.bytes > MAX_PROJECT_BYTES) throw new Error('the project is larger than the import limit')
  if (scan.names.length > MAX_PROJECT_FILES) throw new Error('the project has more files than a composition can have')
  const manifestName = scan.names
    .filter((name) => name.replace(/\\/g, '/').split('/').pop()?.toLowerCase() === MOTION_PROJECT_MANIFEST)
    .sort((a, b) => a.split('/').length - b.split('/').length)[0]
  const rootPrefix = manifestName.includes('/') ? manifestName.slice(0, manifestName.lastIndexOf('/') + 1) : ''

  const wanted: string[] = []
  let bytes = 0
  for (const name of scan.names) {
    const rel = safeZipEntry(rootPrefix, name)
    if (!rel) continue
    wanted.push(name)
  }
  if (!wanted.length) throw new Error('the .zip has no files for the composition')

  const root = piecesDir('motion', opts.sessionId)
  const folder = await uniqueFolder(root, pieceSlug(manifest.name, 'motion'))
  // `entry` vem do manifesto: só vale se for um arquivo que o zip realmente traz.
  const entryRel = manifest.entry.replace(/\\/g, '/').replace(/^\.\//, '')
  const available = wanted.map((name) => name.slice(rootPrefix.length).replace(/\\/g, '/'))
  const entryName = available.includes(entryRel) ? entryRel : available.find((name) => /\.html?$/i.test(name))
  if (!entryName) throw new Error('the project has no HTML entry — it is not a motion composition')

  const entries = unzipSync(data, {
    filter: (file) => wanted.includes(file.name),
  })
  await fsp.mkdir(folder, { recursive: true })
  let files = 0
  try {
    for (const name of wanted) {
      const rel = safeZipEntry(rootPrefix, name)
      if (!rel) continue
      const target = path.resolve(folder, ...rel.split('/'))
      const inside = relativeName(folder, target)
      if (!inside) continue
      const content = entries[name]
      if (!content) continue
      bytes += content.byteLength
      if (bytes > MAX_PROJECT_BYTES) throw new Error('the project is larger than the import limit')
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, content)
      files++
    }
    const registered = await registerMotion(folder, path.join(folder, ...entryName.split('/')), {
      root,
      sessionId: opts.sessionId,
    })
    return {
      id: registered.id,
      name: path.basename(folder),
      folder,
      entry: path.join(folder, ...entryName.split('/')),
      files,
      bytes,
      skipped: scan.names.length - wanted.length,
    }
  } catch (err) {
    // Importação que falhou no meio não pode deixar meia peça ocupando a pasta
    // nem um registro apontando para ela.
    await fsp.rm(folder, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}
