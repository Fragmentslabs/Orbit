import { app, BrowserWindow, protocol } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { MOTION_SCHEME } from '@shared/media'
import { resolveSafePath, type ToolContext } from '../tools/context'
import { isAlphaFormat, motionFormatExt, normalizeMotionFormat, type MotionFormatInput } from './motion-render-args'
import { renderMotion } from './motion'
import { MOTION_RUNTIME, MOTION_RUNTIME_PATH, injectMotionRuntime } from './motion-runtime'

/**
 * Registro das composições de motion (uma PASTA do projeto com um arquivo de
 * entrada e dependências relativas) e o scheme `orbit-motion://` que a serve.
 *
 * Espelha o video/store.ts: o registro guarda id → pasta + entrada, nada é
 * copiado, e todo arquivo servido é resolvido DENTRO da pasta registrada — `..`,
 * caminho absoluto e escape da pasta são recusados. O preview (aba do painel) e
 * o render por IPC leem daqui.
 *
 * Por que um scheme, e não file://: uma página em file:// tem origem opaca, sem
 * CORS e sem módulos; servida por um scheme standard+secure+corsEnabled o
 * `<script type="module">` e o @font-face da composição funcionam. Por isso
 * TODA resposta leva Access-Control-Allow-Origin: *.
 */

const SAFE_MOTION_ID = /^mv_[a-z0-9]+$/

/** Canal do renderer para a recarga ao vivo. */
export const MOTION_CHANGED_CHANNEL = 'motion:changed'
/** Canal do renderer para o progresso do render. */
export const MOTION_PROGRESS_CHANNEL = 'motion:render:progress'

/** Debounce do fs.watch: o editor grava em rajada e não queremos N eventos. */
const WATCH_DEBOUNCE_MS = 150

export interface MotionEntry {
  /** Pasta raiz da composição: o scheme não serve nada fora dela. */
  folder: string
  /** Arquivo de entrada (absoluto), sempre dentro de `folder`. */
  entry: string
  /** Pasta de trabalho que registrou — revalidada quando o painel pede render. */
  root?: string
  sessionId?: string
  createdAt: number
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  // Todas as extensões que o render aceita como trilha precisam tocar no
  // preview: um áudio que o render muxa e a aba não abre seria meia verdade.
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
}

function indexFile(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'motion.json')
}

let index: Record<string, MotionEntry> | null = null

async function load(fresh = false): Promise<Record<string, MotionEntry>> {
  if (index && !fresh) return index
  try {
    const disk = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as Record<string, MotionEntry>
    // Releitura: o que está em memória e ainda não foi gravado não pode sumir.
    index = fresh && index ? { ...disk, ...index } : disk
  } catch {
    index = index ?? {}
  }
  return index
}

/**
 * Id da composição: derivado da pasta + entrada, não sorteado. Registrar de novo
 * a mesma composição (o preview reaberto, o motion_frame, o render) devolve o
 * MESMO id — a aba aberta continua apontando para uma URL válida, em vez de
 * ficar presa num id que outro passo trocou ou liberou.
 */
export function motionIdFor(folder: string, entry: string): string {
  const key = `${path.resolve(folder).toLowerCase()}|${path.resolve(entry).toLowerCase()}`
  return `mv_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

/**
 * A peça registrada a partir do caminho que o agente usou no preview.
 *
 * É o que o card do chat tem em mãos: o `input.path` da tool, que pode ser a
 * pasta da composição ou o HTML de entrada. O renderer não conhece id nenhum —
 * quem sabe traduzir caminho em peça é o registro, aqui.
 */
export async function motionIdForPath(target: string): Promise<string | null> {
  const wanted = path.resolve(target).toLowerCase()
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (path.resolve(entry.entry).toLowerCase() === wanted) return id
    if (path.resolve(entry.folder).toLowerCase() === wanted) return id
  }
  // O agente costuma dar o caminho RELATIVO à pasta da sessão (é o que a tool
  // recebe), e aqui não há sessão para resolver contra: `path.resolve` cairia no
  // cwd do app e não casaria com nada. O FIM do caminho ainda distingue a peça —
  // o registro é curto, uma pasta por composição —, e a barra no início evita
  // que `…/intro` case com `…/orbit-intro`.
  const tail = normalize(target)
  if (!tail.includes("/")) return null
  for (const [id, entry] of Object.entries(entries)) {
    if (normalize(entry.entry).endsWith(`/${tail}`)) return id
    if (normalize(entry.folder).endsWith(`/${tail}`)) return id
  }
  return null
}

/** Caminho comparável: separador normalizado, sem `./` na frente, minúsculo. */
function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase()
}

/**
 * A peça registrada a partir do NOME que a composição tem na conversa.
 *
 * É o caso do modo CHAT: `motion_write({ name, html })` não tem caminho nenhum
 * no `input`, só o nome — a composição mora no armazenamento do Orbit, uma pasta
 * por conversa, e a pasta leva o slug do nome. O card manda o nome que a tool
 * relatou (já normalizado) e a sessão; quem sabe em que pasta ele caiu é o
 * registro. A sessão faz parte da chave porque o mesmo nome em duas conversas
 * são duas peças diferentes.
 */
export async function motionIdForName(sessionId: string, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.sessionId !== sessionId) continue
    if (path.basename(entry.folder).toLowerCase() === wanted) return id
  }
  return null
}

let writing: Promise<void> = Promise.resolve()
function persist(): Promise<void> {
  writing = writing.then(async () => {
    const file = indexFile()
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(index ?? {}))
    await fsp.rename(tmp, file)
  })
  return writing
}

/** `target` está dentro de `root`? (o mesmo teste do resolveSafePath). */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Resolve o caminho de uma URL `orbit-motion://<id>/<caminho>` dentro da pasta
 * da composição. Puro. Recusa caminho vazio, absoluto (inclusive `C:\…`), com
 * `..` em qualquer posição ou que escape da pasta depois de normalizado.
 */
export function resolveMotionFile(folder: string, relative: string): string | null {
  let rel = relative ?? ''
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return null
  }
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel || rel.includes('\0')) return null
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null
  if (rel.split('/').some((segment) => segment === '..')) return null
  const root = path.resolve(folder)
  const target = path.resolve(root, rel)
  return isInside(root, target) ? target : null
}

/** Relativo (com `/`) do arquivo de entrada em relação à pasta. */
function relativeEntry(entry: MotionEntry): string {
  return path
    .relative(entry.folder, entry.entry)
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * Pasta + entrada da composição a partir do que quem chama tem em mãos: o par
 * (pasta, entrada) ou só o caminho da entrada (a pasta é a que a contém; se for
 * uma pasta, a entrada é o index.html dela).
 */
async function resolveComposition(target: string, entry?: string): Promise<{ folder: string; entry: string }> {
  const abs = path.resolve(target)
  if (entry !== undefined) return { folder: abs, entry: path.resolve(entry) }
  let isDir = false
  try {
    isDir = (await fsp.stat(abs)).isDirectory()
  } catch {
    isDir = false
  }
  return isDir ? { folder: abs, entry: path.join(abs, 'index.html') } : { folder: path.dirname(abs), entry: abs }
}

/**
 * Registra (ou reaproveita) uma composição e devolve a URL de preview. A
 * entrada tem que estar dentro da pasta — é o que autoriza o scheme a servir
 * os arquivos dela.
 */
export async function registerMotion(
  folder: string,
  entry?: string,
  opts: { root?: string; sessionId?: string } = {},
): Promise<{ id: string; url: string; created: boolean }> {
  const composition = await resolveComposition(folder, entry)
  const dir = composition.folder
  const file = composition.entry
  if (!isInside(dir, file)) {
    throw new Error(`motion entry ${file} is outside the composition folder ${dir}`)
  }
  const entries = await load()
  const id = motionIdFor(dir, file)
  const existing = entries[id]
  if (existing) {
    // Quem registra de novo (outra sessão, a tool com a pasta de trabalho)
    // atualiza o dono, sem trocar o id nem derrubar o watcher.
    let changed = false
    if (opts.root && existing.root !== path.resolve(opts.root)) {
      existing.root = path.resolve(opts.root)
      changed = true
    }
    if (opts.sessionId && existing.sessionId !== opts.sessionId) {
      existing.sessionId = opts.sessionId
      changed = true
    }
    if (changed) await persist()
  } else {
    entries[id] = {
      folder: dir,
      entry: file,
      root: opts.root ? path.resolve(opts.root) : undefined,
      sessionId: opts.sessionId,
      createdAt: Date.now(),
    }
    await persist()
  }
  if (!watchers.has(id)) watchMotion(id, dir)
  return { id, url: `${MOTION_SCHEME}://${id}/${relativeEntry(entries[id])}`, created: !existing }
}

/** Registro de uma composição (valida o id antes de tocar no índice). */
export async function getMotion(id: string): Promise<MotionEntry | undefined> {
  if (!SAFE_MOTION_ID.test(id)) return undefined
  // Não achou na memória: relê o disco antes de dizer "não existe" — um 404
  // aqui deixa a aba sem composição, e o custo de reler é um arquivo pequeno.
  return (await load())[id] ?? (await load(true))[id]
}

/**
 * URL `orbit-motion://<id>/<entrada>` de uma composição REGISTRADA. É por onde
 * o render carrega a composição (motion.ts) — o mesmo caminho do preview, com o
 * runtime como primeiro script do `<head>`.
 */
export async function registeredMotionUrl(id: string): Promise<string | null> {
  const entry = await getMotion(id)
  return entry ? `${MOTION_SCHEME}://${id}/${relativeEntry(entry)}` : null
}

/**
 * URL do ÁUDIO da composição no scheme: é por aqui que a aba toca a peça com som,
 * pelo mesmo caminho que serve a pasta (nada é copiado para lugar nenhum).
 * `null` quando o arquivo está FORA da pasta — o scheme não serve nada fora da
 * composição, então o render muxa pelo caminho absoluto e o preview fica sem som.
 */
export function motionAudioUrl(id: string, relative: string | null): string | null {
  return relative ? `${MOTION_SCHEME}://${id}/${relative}` : null
}

/** Tira a composição do registro e libera o watcher dela. */
export async function unregisterMotion(id: string): Promise<void> {
  const entries = await load()
  if (!entries[id]) return
  delete entries[id]
  await persist()
  unwatchMotion(id)
}

/**
 * Pastas de composição que o próprio Orbit guarda (o modo chat). Tudo que mora
 * aqui é dele — pode ser apagado sem pedir licença ao projeto de ninguém.
 */
function chatCompositionsRoot(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'motion')
}

/** `child` está estritamente DENTRO de `parent` (nunca igual a ele)? */
function isStrictlyInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export interface MotionDeletion {
  /** A pasta da composição foi apagada do disco. */
  removedFolder: boolean
  /** Por que a pasta ficou, quando ficou (a peça saiu do registro de qualquer jeito). */
  keptBecause?: string
}

/**
 * Apaga uma composição: a PASTA dela, o registro e o watcher.
 *
 * Excluir na galeria é liberar espaço, então a pasta vai embora — mas uma pasta
 * de projeto é do usuário, e o registro só sabe o que o agente declarou. As
 * travas: a pasta tem que ser a composição de verdade (conter o arquivo de
 * entrada) e estar DENTRO de um lugar que este app pode limpar — o
 * armazenamento do modo chat, ou estritamente dentro da pasta de trabalho que
 * registrou a peça. Uma composição que É a pasta de trabalho (index.html na raiz
 * do projeto) nunca apaga a pasta: só sai do registro. Os vídeos renderizados
 * ficam fora da pasta da composição (edit/renders) e não são tocados.
 */
export async function deleteMotionComposition(id: string): Promise<MotionDeletion> {
  const entry = await getMotion(id)
  if (!entry) return { removedFolder: false, keptBecause: 'not registered' }
  const folder = path.resolve(entry.folder)

  let keptBecause: string | undefined
  const stat = await fsp.stat(folder).catch(() => null)
  const hasEntry = await fsp.stat(entry.entry).then((s) => s.isFile()).catch(() => false)
  if (!stat?.isDirectory()) {
    keptBecause = 'the folder no longer exists'
  } else if (!hasEntry) {
    keptBecause = 'the folder does not contain the composition entry'
  } else if (isStrictlyInside(chatCompositionsRoot(), folder)) {
    // do Orbit
  } else if (entry.root && isStrictlyInside(entry.root, folder)) {
    // dentro do projeto que a registrou, e não o projeto em si
  } else {
    keptBecause = 'the folder is the project itself (or outside the working folder it was registered from)'
  }

  if (!keptBecause) await fsp.rm(folder, { recursive: true, force: true })
  await unregisterMotion(id)
  return keptBecause ? { removedFolder: false, keptBecause } : { removedFolder: true }
}

// ------------------------------------------------------------------ watcher
// Recarga ao vivo: o watcher só existe enquanto o id estiver registrado.
const watchers = new Map<string, fs.FSWatcher>()
const debounces = new Map<string, ReturnType<typeof setTimeout>>()

function notifyChanged(id: string): void {
  const pending = debounces.get(id)
  if (pending) clearTimeout(pending)
  debounces.set(
    id,
    setTimeout(() => {
      debounces.delete(id)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(MOTION_CHANGED_CHANNEL, { id })
      }
    }, WATCH_DEBOUNCE_MS),
  )
}

/**
 * O que NÃO recarrega o preview: vídeos renderizados, a pasta temporária do
 * render e arquivos de trabalho. Sem este filtro, um render gravado dentro da
 * pasta da composição recarregava a aba a cada pedaço escrito. Puro.
 */
export function isMotionSourceChange(filename: string | null | undefined): boolean {
  if (!filename) return true
  const name = filename.replace(/\\/g, '/')
  if (name.split('/').some((segment) => segment.startsWith('.motion-') || segment === '.render' || segment.startsWith('.render-'))) return false
  return !/\.(mp4|mov|webm|mkv|m4v|tmp|part|crdownload)$/i.test(name)
}

function watchMotion(id: string, folder: string): void {
  unwatchMotion(id)
  const listener = (_event: string, filename: string | Buffer | null) => {
    if (isMotionSourceChange(filename == null ? null : String(filename))) notifyChanged(id)
  }
  try {
    watchers.set(id, fs.watch(folder, { recursive: true }, listener))
  } catch {
    // Linux não suporta watch recursivo: cai para o nível de cima (entrada e
    // arquivos soltos da pasta, que é o que a composição edita de verdade).
    try {
      watchers.set(id, fs.watch(folder, listener))
    } catch {
      // pasta sumiu desde o registro — o protocolo devolve 404 na hora.
    }
  }
}

export function unwatchMotion(id: string): void {
  const watcher = watchers.get(id)
  if (watcher) {
    try {
      watcher.close()
    } catch {
      // já fechado
    }
    watchers.delete(id)
  }
  const pending = debounces.get(id)
  if (pending) {
    clearTimeout(pending)
    debounces.delete(id)
  }
}

// ----------------------------------------------------------------- protocol
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' } as const

function respond(
  body: BodyInit | null,
  type: string,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  // Um corpo de stream não tem comprimento conhecido: quem o monta diz o
  // `Content-Length` no `extra` (é o tamanho da FAIXA, não do arquivo).
  const length =
    typeof body === 'string' ? Buffer.byteLength(body) : body instanceof Uint8Array ? body.byteLength : null
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': type,
      // A composição é editada com o preview aberto: cache serviria a versão
      // antiga e a recarga ao vivo pareceria não funcionar.
      'Cache-Control': 'no-store',
      // É ESTA linha que diz ao Chromium que o recurso aceita reposicionar.
      // Sem ela um <audio> da peça ainda toca (o fluxo é sequencial), mas
      // `currentTime` vira sugestão: pausar e voltar recomeça do zero.
      'Accept-Ranges': 'bytes',
      ...(length === null ? {} : { 'Content-Length': String(length) }),
      ...extra,
    },
  })
}

/**
 * O que o Chromium carrega como MÍDIA (o `<audio>`/`<video>` da peça). Só estes
 * arquivos dispensam o `no-store` — ver `respondMedia`.
 */
const MEDIA_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.mp4',
  '.webm',
  '.mov',
])

/**
 * Resposta de MÍDIA (o `<audio>`/`<video>` da peça): `respond` SEM `Cache-Control`.
 *
 * O `no-store` existe para a recarga ao vivo — a composição é editada com o
 * preview aberto, e cache serviria os bytes antigos. Mas ele é veneno para uma
 * mídia: sem poder guardar o que já baixou, o elemento refaz o pedido a cada
 * reposicionamento. Enquanto o scheme não anunciava faixas isso não aparecia
 * (todo pedido era sequencial, e o seek era ignorado); agora que ele anuncia — e
 * o Chromium REPOSICIONA de verdade — cada reata descartava o buffer e rebaixava
 * o arquivo, e o som picotava em vez de tocar. É por isso que o `video/store.ts`
 * e o `audio-store.ts`, que sempre tocaram bem, não mandam esse cabeçalho.
 *
 * A recarga ao vivo não perde nada: o preview põe `?r=` na URL da mídia também,
 * então a voz regerada chega por uma URL nova.
 *
 * Só vale para `MEDIA_EXTENSIONS`. O JS/CSS/imagem da composição é pedido pela
 * MESMA URL a cada recarga, e para esses o `no-store` continua sendo o que faz a
 * edição aparecer.
 */
function respondMedia(
  body: BodyInit | null,
  type: string,
  status: number,
  extra: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      ...extra,
    },
  })
}

/** Registra o protocolo das composições (chamar após app.whenReady). */
export function registerMotionProtocol(): void {
  protocol.handle(MOTION_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return respond('bad url', 'text/plain; charset=utf-8', 400)
    }
    const id = decodeURIComponent(url.host)
    if (!SAFE_MOTION_ID.test(id)) return respond('not found', 'text/plain; charset=utf-8', 404)
    const entry = await getMotion(id)
    if (!entry) return respond('not found', 'text/plain; charset=utf-8', 404)
    // Caminho reservado: o script do runtime, o mesmo que o render injeta.
    if (url.pathname === MOTION_RUNTIME_PATH) {
      return respond(MOTION_RUNTIME, 'text/javascript; charset=utf-8')
    }
    const file = resolveMotionFile(entry.folder, url.pathname)
    if (!file) return respond('not found', 'text/plain; charset=utf-8', 404)
    const ext = path.extname(file).toLowerCase()
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream'
    // O HTML não sai como está: o runtime entra no <head>, então o corpo deixa de
    // ser o arquivo e faixa não se aplica.
    if (ext === '.html' || ext === '.htm') {
      const html = await fsp.readFile(file, 'utf8').catch(() => null)
      if (html === null) return respond('file moved or deleted', 'text/plain; charset=utf-8', 404)
      return respond(injectMotionRuntime(html, MOTION_SCHEME, id), type)
    }
    const size = await fsp
      .stat(file)
      .then((stat) => (stat.isFile() ? stat.size : null))
      .catch(() => null)
    if (size === null) return respond('file moved or deleted', 'text/plain; charset=utf-8', 404)
    const stream = (start: number, end: number) =>
      Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream
    // Só a mídia perde o `no-store` (ver `respondMedia`): para todo o resto ele
    // continua sendo o que faz a recarga ao vivo mostrar a edição.
    const send = MEDIA_EXTENSIONS.has(ext) ? respondMedia : respond
    // Faixa (a mesma resposta que o video/store.ts dá ao <video>): é por aqui que
    // o Chromium REPOSICIONA a narração da peça no preview. Sem esta resposta o
    // recurso é tratado como não-buscável — o som toca na minutagem certa, mas
    // pausar no meio e voltar recomeça o arquivo do zero.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
        return respond(null, 'text/plain; charset=utf-8', 416, { 'Content-Range': `bytes */${size}` })
      }
      return send(stream(start, end), type, 206, {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      })
    }
    return send(size > 0 ? stream(0, size - 1) : new Uint8Array(0), type, 200, {
      'Content-Length': String(size),
    })
  })
}

// -------------------------------------------------------------- render (IPC)
export interface MotionRenderRequest {
  /**
   * Saída pretendida: `mp4` (H.264), `mov-alpha` (ProRes 4444 com alfa) ou
   * `webm-alpha` (VP9 com alfa). Os nomes antigos (`mov`, `webm`) seguem sendo
   * aceitos. Contrato congelado com a aba do painel (ver src/lib/ipc.ts).
   */
  format?: MotionFormatInput
  /** Caminho de saída relativo à pasta de trabalho (padrão: render.<ext>). */
  output?: string
  /**
   * Destino ABSOLUTO escolhido pela PESSOA no diálogo nativo — o render da aba
   * do painel.
   *
   * Diferente de `output`, não passa pelo resolveSafePath: quem escolheu foi o
   * dono da máquina, num diálogo do sistema, e a gravação pode legitimamente
   * cair fora das pastas do projeto. `output` continua sendo o caminho do
   * AGENTE, e por isso continua preso às raízes autorizadas.
   */
  saveAs?: string
  /** Redundante com os formatos `-alpha`, mas continua valendo para os antigos. */
  transparent?: boolean
  /** Faixas paralelas; 1 = sequencial (determinístico). */
  bands?: number
  width?: number
  height?: number
  fps?: number
  duration?: number
}

export interface MotionRenderResult {
  id: string
  /** Caminho absoluto do arquivo renderizado. */
  path: string
  width: number
  height: number
  fps: number
  duration: number
  frames: number
}

/**
 * Onde o render da peça nasceria se ninguém escolhesse: ao lado da composição.
 *
 * É o ponto de partida do diálogo de salvar do main — a pessoa confirma ou
 * troca a pasta, mas abre já no lugar certo, com o nome e a extensão do formato
 * que ela pediu. `null` quando a composição não está mais registrada.
 */
export async function suggestedMotionOutput(
  id: string,
  format?: MotionFormatInput,
): Promise<string | null> {
  const entry = await getMotion(id)
  if (!entry) return null
  return path.join(entry.folder, `render${motionFormatExt(normalizeMotionFormat(format, false))}`)
}

/**
 * Renderiza uma composição REGISTRADA (o que o IPC `motion:render` chama). O
 * painel manda só o id; ainda assim o arquivo de entrada é revalidado com o
 * resolveSafePath (a mesma checagem da tool) contra a raiz que registrou, senão
 * um registro adulterado no disco viraria render de HTML arbitrário.
 *
 * Não mexe no interior do render: só repassa as opções e o callback de
 * progresso.
 */
export async function renderRegisteredMotion(
  id: string,
  req: MotionRenderRequest = {},
  onProgress?: (frame: number, total: number) => void,
): Promise<MotionRenderResult> {
  const entry = await getMotion(id)
  if (!entry) throw new Error(`unknown motion composition: ${id}`)
  // A pasta da composição é a raiz permitida; a pasta de trabalho que a
  // registrou entra como pasta extra para o caso de a composição ter vindo de
  // uma pasta anexada (a mesma lista de raízes que a tool usou).
  const ctx: ToolContext = {
    sessionId: entry.sessionId ?? '',
    directory: entry.folder,
    extraDirectories: entry.root ? [entry.root] : [],
    abort: new AbortController().signal,
  }
  const file = resolveSafePath(ctx, entry.entry)
  if (!isInside(entry.folder, file)) {
    throw new Error(`motion entry ${file} escaped its composition folder`)
  }
  // O formato é a ÚNICA decisão de encoder (o alfa vem do nome: `-alpha`).
  const format = normalizeMotionFormat(req.format, Boolean(req.transparent))
  const alpha = isAlphaFormat(format)
  if (req.transparent && !alpha) {
    throw new Error('transparent render needs format "mov-alpha" (ProRes 4444) or "webm-alpha" (VP9 with alpha)')
  }
  const output = req.saveAs
    ? path.resolve(req.saveAs)
    : req.output
      ? resolveSafePath(ctx, req.output)
      : path.join(entry.folder, `render${motionFormatExt(format)}`)
  await fsp.mkdir(path.dirname(output), { recursive: true })
  const result = await renderMotion({
    // Já está registrada: o render não registra de novo nem libera no fim.
    id,
    file,
    output,
    format,
    transparent: alpha,
    bands: req.bands,
    width: req.width,
    height: req.height,
    fps: req.fps,
    duration: req.duration,
    onProgress,
  })
  return {
    id,
    path: output,
    width: result.width,
    height: result.height,
    fps: result.fps,
    duration: result.duration,
    frames: result.frames,
  }
}
