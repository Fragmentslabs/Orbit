import { app } from 'electron'
import fsp from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { motionBundleKey, type MotionBundle, type MotionBundleFile } from '@shared/media'
import { motionPiecesForSession } from './motion-store'

/**
 * Os ARQUIVOS de cada composição, do jeito que o chat precisa vê-los.
 *
 * Uma peça de motion é uma PASTA: o HTML de entrada, as mídias que entraram por
 * `motion_asset`, as fontes, o acervo que o agente baixou, o `audio.json` das
 * trilhas. No chat, cada áudio ou imagem trazida para dentro virava um player
 * solto na mensagem — e o que foi gerado e depois trocado continuava lá,
 * ocupando a conversa com material que a peça não usa mais (ou nunca usou).
 *
 * Aqui mora o que o card da peça lê: a LISTA DA PASTA (essa é a verdade — nada
 * é apagado, o arquivo que ficou de fora continua no disco) cruzada com o
 * registro de ORIGEM de cada arquivo, gravado no momento em que ele entrou
 * (`motion_asset`). Com a origem, o chat reconhece o player de um áudio gerado
 * como sendo da peça e o recolhe no card em vez de mostrá-lo solto.
 *
 * "Usado" não é uma etiqueta gravada: é DERIVADO — o arquivo é citado no
 * HTML/CSS/JS da composição ou no `audio.json` dela. Assim a conta nunca fica
 * velha: quando o agente troca a narração no `audio.json`, o arquivo antigo
 * passa a "descartado" sozinho, sem ninguém precisar marcá-lo.
 */

export interface MotionFileRecord {
  /** Caminho relativo dentro da pasta da peça, sempre com `/`. */
  name: string
  /** Referências de anexo de onde o arquivo veio (`aud_…`, `img_…`, `vdo_…`). */
  refs: string[]
  /** Caminhos de origem (modo código: um arquivo da pasta de trabalho). */
  sources: string[]
  /** Quando entrou na peça (ms). */
  addedAt: number
}

interface BundleEntry {
  folder: string
  sessionId?: string
  files: MotionFileRecord[]
}

type FileIndex = Record<string, BundleEntry>

const SAFE_MOTION_ID = /^mv_[a-z0-9]+$/
/** Teto de arquivos listados por peça: uma composição é uma pasta pequena. */
const MAX_FILES = 400
/** Até onde a listagem desce (uma peça usa no máximo um nível de subpasta). */
const MAX_DEPTH = 3
/** Arquivo de texto maior que isto não entra na varredura de citações. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
/** Quantos arquivos a varredura de citações lê, no máximo. */
const MAX_SOURCE_FILES = 40
/** O que a varredura de "usado" lê: o que a composição pode citar um arquivo. */
const SOURCE_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.srt', '.vtt', '.txt'])
/**
 * Arquivos da pasta que NÃO entram na lista: o HTML de entrada (a peça em si) e
 * os manifestos internos. `audio.json` continua sendo LIDO — mas como fonte de
 * citações, não como item da lista.
 */
const INTERNAL_FILES = new Set(['index.html', 'audio.json', 'orbit.json'])

const EXT_KIND: Record<string, MotionBundleFile['kind']> = {
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.ogg': 'audio',
  '.oga': 'audio',
  '.opus': 'audio',
  '.flac': 'audio',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.bmp': 'image',
  '.svg': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mkv': 'video',
  '.m4v': 'video',
  '.woff': 'font',
  '.woff2': 'font',
  '.ttf': 'font',
  '.otf': 'font',
}

function indexFile(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'motion-files.json')
}

let index: FileIndex | null = null
let writing: Promise<void> = Promise.resolve()

async function load(fresh = false): Promise<FileIndex> {
  if (index && !fresh) return index
  try {
    const disk = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as FileIndex
    // Releitura: o que está em memória e ainda não foi gravado não pode sumir.
    index = fresh && index ? { ...disk, ...index } : disk
  } catch {
    index = index ?? {}
  }
  return index
}

function persist(): Promise<void> {
  const snapshot = JSON.stringify(index ?? {}, null, 2)
  writing = writing
    .then(async () => {
      const file = indexFile()
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, snapshot, 'utf8')
    })
    .catch(() => {
      // Índice de origem é conveniência do card: se o disco recusar a gravação,
      // a peça continua funcionando — só não haverá a que card ligar o arquivo.
    })
  return writing
}

/** Nome relativo dentro da pasta, com `/` e sem escapar dela. */
export function pieceFileName(folder: string, file: string): string | null {
  const rel = path.relative(path.resolve(folder), path.resolve(file))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/**
 * Registra de ONDE veio um arquivo que acabou de entrar na peça.
 *
 * Chamado por `motion_asset`, logo depois da cópia — é o que liga `narracao.wav`
 * dentro da pasta ao `aud_…` que o chat mostrou como player. O mesmo arquivo
 * pode receber origens diferentes ao longo da vida (a narração regravada que
 * caiu no mesmo nome por ter o mesmo tamanho): as duas ficam guardadas, porque
 * as duas mensagens continuam na conversa.
 */
export async function recordMotionFile(
  piece: { id: string; folder: string; sessionId?: string },
  file: { name?: string; ref?: string; source?: string },
): Promise<void> {
  if (!SAFE_MOTION_ID.test(piece.id)) return
  const name = file.name ? file.name.split(path.sep).join('/') : ''
  if (!name) return
  const entries = await load()
  const entry = entries[piece.id] ?? { folder: piece.folder, files: [] }
  entry.folder = piece.folder
  if (piece.sessionId) entry.sessionId = piece.sessionId
  const record = entry.files.find((f) => f.name === name) ?? { name, refs: [], sources: [], addedAt: 0 }
  if (file.ref && !record.refs.includes(file.ref)) record.refs.push(file.ref)
  if (file.source && !record.sources.includes(file.source)) record.sources.push(file.source)
  // Reimportar o mesmo arquivo (o mesmo nome, o mesmo conteúdo) não é novidade:
  // a data só anda quando o arquivo realmente entra pela primeira vez.
  if (!record.addedAt) record.addedAt = Date.now()
  if (!entry.files.some((f) => f.name === name)) entry.files.push(record)
  entries[piece.id] = entry
  await persist()
}

/** A peça saiu do registro: o que sabíamos das origens dela não serve mais. */
export async function forgetMotionFiles(id: string): Promise<void> {
  const entries = await load()
  if (!entries[id]) return
  delete entries[id]
  await persist()
}

/** Um arquivo da pasta, já com o que a lista do card mostra. */
interface ListedFile {
  name: string
  size: number
  mtimeMs: number
}

async function listFolder(root: string, dir = root, depth = 0, out: ListedFile[] = []): Promise<ListedFile[]> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out
  let items: Dirent[]
  try {
    items = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const item of items) {
    if (out.length >= MAX_FILES) break
    // Ponto na frente é arquivo de sistema (o `.motion-*` do editor, o `.DS_Store`).
    if (item.name.startsWith('.')) continue
    const abs = path.join(dir, item.name)
    if (item.isDirectory()) {
      await listFolder(root, abs, depth + 1, out)
      continue
    }
    if (!item.isFile()) continue
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat || !stat.size) continue
    // O nome é SEMPRE relativo à raiz da peça (`fonts/inter.woff2`), mesmo
    // quando o arquivo está numa subpasta.
    const rel = pieceFileName(root, abs)
    if (!rel) continue
    if (depth === 0 && INTERNAL_FILES.has(rel.toLowerCase())) continue
    out.push({ name: rel, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  return out
}

/**
 * Todo o texto que pode CITAR um arquivo da peça: o HTML de entrada, o
 * `audio.json` e os CSS/JS que ele carrega. É a fonte do "usado".
 */
async function readCompositionSources(folder: string, entry: string | null): Promise<string> {
  const parts: string[] = []
  const seen = new Set<string>()
  const add = async (abs: string): Promise<void> => {
    const key = abs.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat?.isFile() || stat.size > MAX_SOURCE_BYTES) return
    try {
      parts.push(await fsp.readFile(abs, 'utf8'))
    } catch {
      // ilegível/ binário: fica de fora
    }
  }
  if (entry) await add(entry)
  const walk = async (dir: string, depth: number): Promise<void> => {
    // Teto de arquivos lidos: uma peça cita meia dúzia; o resto (um
    // node_modules que caísse na pasta) não muda a resposta e custa caro.
    if (depth > 1 || parts.length >= MAX_SOURCE_FILES) return
    let items: Dirent[]
    try {
      items = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const abs = path.join(dir, item.name)
      if (item.isDirectory()) {
        await walk(abs, depth + 1)
        continue
      }
      if (!item.isFile()) continue
      if (!SOURCE_EXTENSIONS.has(path.extname(item.name).toLowerCase())) continue
      // O manifesto exportado lista todos os arquivos — se ele entrasse na
      // varredura, todo arquivo pareceria "usado".
      if (item.name.toLowerCase() === 'orbit.json') continue
      await add(abs)
    }
  }
  await walk(folder, 0)
  return parts.join('\n')
}

/**
 * O nome aparece no texto como ARQUIVO, não como pedaço de outra palavra
 * (`a.wav` dentro de `data.wav` não conta). Vale o caminho e o nome solto, e
 * também a forma percent-encoded, que é como um nome com espaço viaja numa URL.
 */
export function mentionsFile(text: string, name: string): boolean {
  const base = name.split('/').pop() ?? name
  const needles = new Set<string>()
  for (const candidate of [name, base]) {
    if (!candidate) continue
    needles.add(candidate)
    try {
      const encoded = encodeURI(candidate)
      if (encoded !== candidate) needles.add(encoded)
    } catch {
      // nome com % solto: vale só a forma crua
    }
  }
  for (const needle of needles) {
    let from = 0
    for (;;) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      const before = at === 0 ? '' : text[at - 1]
      const after = text[at + needle.length] ?? ''
      // `./narracao.wav`, `"narracao.wav"`, `src=narracao.wav` passam; `x-narracao.wav`
      // (outro arquivo) não.
      if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_.-]/.test(after)) return true
      from = at + 1
    }
  }
  return false
}

function kindOf(name: string): MotionBundleFile['kind'] {
  return EXT_KIND[path.extname(name).toLowerCase()] ?? 'file'
}

async function bundleFor(
  id: string,
  folder: string,
  entry: string | null,
  records: MotionFileRecord[],
): Promise<MotionBundle | null> {
  const listed = await listFolder(folder)
  if (!listed.length) return null
  const sources = await readCompositionSources(folder, entry)
  const byName = new Map(records.map((r) => [r.name, r]))
  const files: MotionBundleFile[] = listed.map((file) => {
    const record = byName.get(file.name)
    return {
      name: file.name,
      size: file.size,
      kind: kindOf(file.name),
      used: mentionsFile(sources, file.name),
      addedAt: record?.addedAt || Math.round(file.mtimeMs),
    }
  })
  files.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name))
  const keys = new Set<string>()
  for (const record of records) {
    for (const value of [...record.refs, ...record.sources]) {
      const key = motionBundleKey(value)
      if (key) keys.add(key)
    }
  }
  return {
    motionId: id,
    name: path.basename(folder),
    folder,
    files,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    discarded: files.filter((f) => !f.used).length,
    keys: [...keys],
  }
}

/**
 * Os cards de peça de uma conversa — um por composição que tenha arquivo na
 * pasta. A lista sai da UNIÃO de duas fontes: o registro do que entrou por
 * `motion_asset` (que traz as origens) e o registro das composições da sessão
 * (que traz a entrada de cada uma). Nenhuma das duas basta sozinha: a peça pode
 * ter arquivos que nunca passaram pelo `motion_asset`, e pode ter sido
 * registrada antes de o primeiro arquivo entrar.
 */
export async function listMotionBundles(sessionId: string): Promise<MotionBundle[]> {
  const pieces = new Map<string, { id: string; folder: string; entry: string | null }>()
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.sessionId !== sessionId) continue
    pieces.set(id, { id, folder: entry.folder, entry: null })
  }
  for (const piece of await motionPiecesForSession(sessionId)) {
    // A entrada vem do registro: é ela que fica de fora da lista.
    pieces.set(piece.id, { id: piece.id, folder: piece.folder, entry: piece.entry })
  }
  const bundles: MotionBundle[] = []
  for (const piece of pieces.values()) {
    const records = entries[piece.id]?.files ?? []
    const bundle = await bundleFor(piece.id, piece.folder, piece.entry, records)
    if (bundle) bundles.push(bundle)
  }
  return bundles.sort((a, b) => a.name.localeCompare(b.name))
}
