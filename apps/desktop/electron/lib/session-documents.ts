import { app, BrowserWindow, dialog } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { StorageKeys, type SessionInfo } from '@shared/chat'
import { extractDocument, type DocumentKind, type ExtractedDocument } from './documents'
import { documentKindOf } from './document-pages'
import { readJson } from './storage'
import { fetchReadablePage } from './tools/web'
import {
  MAX_RASTER_PAGES,
  printFile,
  rasterizePdf,
  type PdfOutlineItem,
  type PdfTextItem,
} from './pdf-raster'

/**
 * Documentos com que a conversa trabalha — as FONTES.
 *
 * O modo chat não tem `read` nem `bash`: até aqui, a ÚNICA forma de um
 * documento chegar ao modelo era o anexo despejar o texto inteiro numa
 * TextPart — que o toModelMessages reenvia a cada turno. Um PDF de 300
 * páginas ficava na janela de contexto para sempre, sendo cobrado de novo em
 * toda mensagem.
 *
 * Agora o texto extraído é persistido AQUI e a mensagem carrega só um trecho
 * de abertura. O resto o agente alcança pelas tools doc_search/doc_read,
 * pagando apenas pelas páginas que realmente usar.
 *
 * Persistir é obrigatório, não otimização: o chip do anexo descarta os bytes
 * originais depois do turno (attachmentChip zera a url em tudo que não é
 * imagem). Sem esta cópia, o documento existiria só no turno em que foi
 * enviado e qualquer pergunta posterior não teria o que ler.
 *
 * DOIS ESCOPOS, e a diferença é de INTENÇÃO:
 *
 * - `doc1, doc2…` — anexo da conversa. Você jogou um arquivo para perguntar
 *   uma coisa; isso não é declaração de corpus. Vale só ali, nos dois modos.
 * - `src1, src2…` — fonte da pasta da sidebar, declarada de propósito. Vale
 *   para todas as conversas daquela pasta.
 *
 * O prefixo do id é o que diz onde o arquivo mora, então resolver um id não
 * precisa procurar nos dois lugares. E ele nunca colide: dois chats da mesma
 * pasta podem ter cada um o seu doc2 sem se ver, porque o que é compartilhado
 * está no outro espaço de nomes.
 *
 * Promover (anexo → fonte) é um ato explícito do usuário na aba Fontes. Nada
 * escorre para a pasta sozinho: fonte errada é silenciosa e muda respostas em
 * OUTRAS conversas, enquanto o clique a mais é visível na hora.
 */

export interface SessionDocument {
  /** Id curto usado pelo modelo nas tools — legível e barato. `docN` é anexo
   *  da conversa; `srcN` é fonte compartilhada da pasta. */
  id: string
  /** Conversa em que o documento entrou. Continua gravado depois de promovido:
   *  é o que deixa a aba dizer de onde aquele arquivo veio. */
  sessionId: string
  filename: string
  kind: DocumentKind
  totalPages: number
  totalChars: number
  truncated: boolean
  /** Tamanho do arquivo original, para a aba mostrar o que ocupa em disco. */
  sizeBytes?: number
  createdAt: number
  /** true quando mora no escopo da pasta (id `srcN`). */
  shared?: boolean
  /** Endereço de origem, nas fontes de site — é o que o usuário reconhece e
   *  o que permite abrir a página de novo. */
  sourceUrl?: string
}

interface StoredDocument extends SessionDocument {
  pages: ExtractedDocument['pages']
}

/** Só aceita os ids que nós mesmos geramos — nada de path traversal vindo de
 *  uma chamada de tool que o modelo inventou. */
const SAFE_ID = /^(doc|src)[0-9]+$/
const SAFE_SCOPE = /^[a-zA-Z0-9_-]+$/

/** Onde um id mora, lido do próprio id. */
function isShared(id: string): boolean {
  return id.startsWith('src')
}

function scopeDir(scope: string): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'session-docs', scope)
}

interface Scopes {
  /** Escopo da conversa — sempre existe. */
  session: string
  /** Escopo da pasta da sidebar, quando a conversa está em uma. */
  folder: string | null
}

/**
 * Os dois escopos visíveis para esta conversa.
 *
 * O folderId é lido da sessão persistida no momento do uso, e não recebido
 * como parâmetro, porque ele muda quando o usuário arrasta o chat entre
 * pastas — mesmo motivo do resolveFolderId das tools de documento.
 */
async function scopesOf(sessionId: string): Promise<Scopes> {
  const session = SAFE_SCOPE.test(sessionId) ? sessionId : ''
  const folderId = await documentFolderId(sessionId)
  return {
    session,
    folder: folderId && SAFE_SCOPE.test(folderId) ? `folder-${folderId}` : null,
  }
}

/** A pasta da conversa, quando ela está em uma. */
export async function documentFolderId(sessionId: string): Promise<string | null> {
  try {
    const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    return session?.folderId ?? null
  } catch {
    return null
  }
}

/** Diretório em que um id mora, ou null quando aquele escopo não existe. */
function dirForId(scopes: Scopes, id: string): string | null {
  const scope = isShared(id) ? scopes.folder : scopes.session
  return scope ? scopeDir(scope) : null
}

async function readStoredAt(dir: string | null, id: string): Promise<StoredDocument | null> {
  if (!dir || !SAFE_ID.test(id)) return null
  try {
    const raw = await fsp.readFile(path.join(dir, `${id}.json`), 'utf8')
    const parsed = JSON.parse(raw) as StoredDocument
    if (!Array.isArray(parsed.pages)) return null
    return { ...parsed, id, shared: isShared(id) }
  } catch {
    return null
  }
}

/** Documentos de um escopo, em ordem de anexação. */
async function readScope(scope: string | null): Promise<SessionDocument[]> {
  if (!scope || !SAFE_SCOPE.test(scope)) return []
  const dir = scopeDir(scope)
  let files: string[]
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const docs: SessionDocument[] = []
  for (const file of files) {
    const stored = await readStoredAt(dir, file.replace(/\.json$/, ''))
    if (stored) docs.push({ ...stored, pages: undefined } as SessionDocument)
  }
  return docs.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Tudo que esta conversa alcança: as fontes da pasta e os anexos dela.
 *
 * As fontes vêm primeiro porque são o corpus declarado — quando o agente
 * percorre a lista para decidir onde procurar, é por onde deve começar.
 */
export async function listSessionDocuments(sessionId: string): Promise<SessionDocument[]> {
  const scopes = await scopesOf(sessionId)
  const [shared, own] = await Promise.all([readScope(scopes.folder), readScope(scopes.session)])
  return [...shared, ...own]
}

/** A visão da aba Fontes: os dois grupos separados, com o que a UI precisa
 *  para rotular o escopo e mostrar o espaço em disco. */
export async function listSessionSources(sessionId: string): Promise<{
  shared: SessionDocument[]
  own: SessionDocument[]
  folderId: string | null
  usage: number
}> {
  const scopes = await scopesOf(sessionId)
  const [shared, own] = await Promise.all([readScope(scopes.folder), readScope(scopes.session)])
  const [sharedBytes, ownBytes] = await Promise.all([
    scopeUsage(scopes.folder),
    scopeUsage(scopes.session),
  ])
  return {
    shared,
    own,
    folderId: await documentFolderId(sessionId),
    usage: sharedBytes + ownBytes,
  }
}

/**
 * Escopo do chat que ainda não existe.
 *
 * Um chat novo é um RASCUNHO: a sessão só nasce ao enviar a primeira mensagem.
 * Sem um escopo próprio, anexar antes disso seria impossível — e obrigar a
 * mandar uma mensagem só para poder anexar inverte a ordem natural de "trago o
 * material, depois pergunto".
 *
 * É um escopo fixo, e não um por rascunho, pelo mesmo motivo do rascunho de
 * texto do input (draft-input.ts): a UI tem um chat novo por vez.
 */
export const DRAFT_SCOPE = 'draft'

/** Contador por escopo. O arquivo é o que garante que o id nunca volte. */
const COUNTER_FILE = 'counter.json'

/**
 * Próximo id do escopo, de um contador que só cresce.
 *
 * Olhar só o que está no disco não basta: apagar o documento de maior número e
 * anexar outro devolveria o mesmo id, e a conversa já disse antes que "doc1 é
 * o contrato" — o agente leria o arquivo errado achando que leu o certo. O
 * maior id existente entra como piso para escopos criados antes do contador.
 */
async function allocateId(scope: string, prefix: 'doc' | 'src'): Promise<string> {
  const dir = scopeDir(scope)
  let next = 1
  try {
    const saved = JSON.parse(await fsp.readFile(path.join(dir, COUNTER_FILE), 'utf8')) as {
      next?: number
    }
    if (typeof saved.next === 'number' && saved.next > 0) next = saved.next
  } catch {
    // Escopo novo, ou anterior ao contador: o piso vem do que está gravado.
  }
  for (const doc of await readScope(scope)) {
    const n = Number(doc.id.slice(3))
    if (Number.isFinite(n) && n >= next) next = n + 1
  }
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, COUNTER_FILE), JSON.stringify({ next: next + 1 }), 'utf8')
  return `${prefix}${next}`
}

/**
 * Extrai e guarda um documento. Retorna o registro sem as páginas — quem
 * chama monta o trecho de abertura com o que vem em `pages`.
 *
 * `shared` só é honrado quando a conversa está numa pasta; sem pasta não há
 * escopo maior para compartilhar e o documento fica na conversa.
 */
export async function saveSessionDocument(
  sessionId: string,
  bytes: Buffer,
  filename: string,
  kind: DocumentKind,
  options: { shared?: boolean; sourceUrl?: string } = {},
): Promise<{ doc: SessionDocument; pages: ExtractedDocument['pages'] }> {
  const scopes = await scopesOf(sessionId)
  const toFolder = Boolean(options.shared && scopes.folder)
  const scope = toFolder ? (scopes.folder as string) : scopes.session
  const extracted = await extractDocument(bytes, kind)
  const doc: SessionDocument = {
    id: await allocateId(scope, toFolder ? 'src' : 'doc'),
    sessionId,
    filename,
    kind,
    totalPages: extracted.totalPages,
    totalChars: extracted.totalChars,
    truncated: extracted.truncated,
    sizeBytes: bytes.length,
    createdAt: Date.now(),
    shared: toFolder,
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
  }
  await writeDocument(scopeDir(scope), doc, extracted.pages, kind === 'spreadsheet' || kind === 'pdf' || kind === 'docx' ? bytes : null)
  notifyDocumentsChanged()
  return { doc, pages: extracted.pages }
}

/**
 * Grava o registro e, quando o tipo pede, o ARQUIVO ORIGINAL ao lado.
 *
 * Planilha, PDF e DOCX guardam o original por motivos diferentes. Na planilha,
 * o texto extraído serve para ler mas não para calcular: ali o valor já vem
 * formatado como ela o exibe, e somar a partir disso obrigaria a reparsear
 * "1.234,56" — onde mora o erro silencioso de locale. No PDF, o motivo é
 * rasterizar: um digitalizado não tem camada de texto, e a única forma de
 * lê-lo é renderizar a página e olhar. O DOCX entra pelo mesmo motivo com
 * outro fim: editar preservando a formatação só é possível partindo do
 * arquivo original.
 */
async function writeDocument(
  dir: string,
  doc: SessionDocument,
  pages: ExtractedDocument['pages'],
  original: Buffer | null,
): Promise<void> {
  const stored: StoredDocument = { ...doc, pages }
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${doc.id}.json`), JSON.stringify(stored), 'utf8')
  if (original) await fsp.writeFile(path.join(dir, `${doc.id}.bin`), original)
}

/**
 * Passa as fontes do rascunho para a sessão que acabou de nascer.
 *
 * Chamado quando a primeira mensagem cria a sessão — mesmo momento em que o
 * app adota o texto do input, o toggle do Brain e o modelo escolhidos no
 * rascunho. Depois disso o escopo do rascunho fica vazio para o próximo chat
 * novo.
 *
 * Os ids são reatribuídos pelo contador da sessão em vez de renomear o
 * diretório: a sessão pode já ter documentos (raro, mas possível se algo
 * anexou antes), e um `doc1` chegando por cima de outro `doc1` apagaria o que
 * já estava lá.
 */
export async function adoptDraftDocuments(sessionId: string): Promise<number> {
  if (!SAFE_SCOPE.test(sessionId) || sessionId === DRAFT_SCOPE) return 0
  const from = scopeDir(DRAFT_SCOPE)
  let files: string[]
  try {
    files = (await fsp.readdir(from)).filter(
      (file) => file.endsWith('.json') && SAFE_ID.test(file.replace(/\.json$/, '')),
    )
  } catch {
    return 0
  }
  if (files.length === 0) {
    await fsp.rm(from, { recursive: true, force: true })
    return 0
  }

  const target = scopeDir(sessionId)
  await fsp.mkdir(target, { recursive: true })
  let adopted = 0
  for (const file of files.sort()) {
    const oldId = file.replace(/\.json$/, '')
    try {
      const raw = await fsp.readFile(path.join(from, file), 'utf8')
      const stored = JSON.parse(raw) as StoredDocument
      const id = await allocateId(sessionId, 'doc')
      await fsp.writeFile(
        path.join(target, `${id}.json`),
        JSON.stringify({ ...stored, id, sessionId }),
        'utf8',
      )
      // O arquivo original vai junto: sem ele o documento perderia a
      // rasterização, o sheet_query e a edição preservando formatação.
      await fsp.rename(path.join(from, `${oldId}.bin`), path.join(target, `${id}.bin`)).catch(() => {})
      adopted += 1
    } catch {
      // Um arquivo ilegível não pode impedir a adoção dos outros.
    }
  }
  await fsp.rm(from, { recursive: true, force: true })
  notifyDocumentsChanged()
  return adopted
}

/** Reconstrói o ExtractedDocument de um documento guardado. */
export async function readSessionDocument(
  sessionId: string,
  docId: string,
): Promise<{ doc: SessionDocument; extracted: ExtractedDocument } | null> {
  const scopes = await scopesOf(sessionId)
  const stored = await readStoredAt(dirForId(scopes, docId), docId)
  if (!stored) return null
  return {
    doc: stored,
    extracted: {
      kind: stored.kind,
      pages: stored.pages,
      totalPages: stored.totalPages,
      totalChars: stored.totalChars,
      truncated: stored.truncated,
    },
  }
}

export interface DocumentHit {
  docId: string
  filename: string
  page: number
  /** Linha dentro da página (1-indexada) — é o que a citação aponta. */
  lineNumber: number
  line: string
  /** Tipo e rótulo da página, para o resultado dizer "aba3 (Custos)" em vez de
   *  "p3" — numa planilha o número é índice de aba, não página. */
  kind: DocumentKind
  label?: string
}

/**
 * Busca nos documentos que a conversa alcança. Devolve no MÁXIMO uma
 * ocorrência por página: o objetivo é localizar onde ler, não trazer o texto —
 * trazer todas as ocorrências recriaria, por outro caminho, o despejo que esta
 * camada existe para evitar.
 */
export async function searchSessionDocuments(
  sessionId: string,
  pattern: RegExp,
  docId: string | undefined,
  maxHits: number,
): Promise<DocumentHit[]> {
  const docs = docId ? [] : await listSessionDocuments(sessionId)
  const targets = docId ? [docId] : docs.map((d) => d.id)
  const hits: DocumentHit[] = []

  for (const id of targets) {
    const found = await readSessionDocument(sessionId, id)
    if (!found) continue
    for (const page of found.extracted.pages) {
      const lines = page.text.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (!pattern.test(lines[i])) continue
        hits.push({
          docId: id,
          filename: found.doc.filename,
          page: page.num,
          lineNumber: i + 1,
          line: lines[i].trim().slice(0, 250),
          kind: found.doc.kind,
          label: page.label,
        })
        break
      }
      if (hits.length >= maxHits) return hits
    }
  }
  return hits
}


/** Extensão do arquivo original por tipo — só os que têm arquivo guardado. */
const ORIGINAL_EXT: Partial<Record<DocumentKind, string>> = {
  pdf: 'pdf',
  docx: 'docx',
}

/**
 * Caminho do arquivo ORIGINAL de uma fonte, para o protocolo servi-lo ao
 * painel. null quando o tipo não guarda original (texto colado, site) ou
 * quando o arquivo não está mais lá.
 */
export async function sessionDocumentFile(
  sessionId: string,
  docId: string,
): Promise<{ path: string; ext: string } | null> {
  if (!SAFE_ID.test(docId)) return null
  const found = await readSessionDocument(sessionId, docId)
  const ext = found && ORIGINAL_EXT[found.doc.kind]
  if (!ext) return null
  const dir = dirForId(await scopesOf(sessionId), docId)
  if (!dir) return null
  const file = path.join(dir, `${docId}.bin`)
  try {
    await fsp.access(file)
  } catch {
    return null
  }
  return { path: file, ext }
}

/**
 * Todas as páginas em texto, para o painel rolar o documento inteiro.
 *
 * Vai de uma vez, e não página a página: a leitura do MODELO é paginada
 * porque cada página custa contexto, mas quem está olhando a tela quer rolar.
 * O teto global da extração (8MB) já limita o pior caso.
 */
/** O documento como o painel lateral o consome, venha de onde vier. */
export interface SessionDocumentView {
  filename: string
  kind: DocumentKind
  totalPages: number
  pages: { num: number; label?: string; lines: string[] }[]
  sourceUrl?: string
  /** true quando existe arquivo original exibível (PDF) — é o que decide se o
   *  modo Original aparece. */
  hasOriginal: boolean
}

export async function readSessionText(
  sessionId: string,
  docId: string,
): Promise<SessionDocumentView | null> {
  const found = await readSessionDocument(sessionId, docId)
  if (!found) return null
  return {
    filename: found.doc.filename,
    kind: found.doc.kind,
    totalPages: found.extracted.totalPages,
    pages: found.extracted.pages.map((page) => ({
      num: page.num,
      label: page.label,
      lines: page.text.split('\n'),
    })),
    sourceUrl: found.doc.sourceUrl,
    // Só PDF: `hasOriginal` decide se o painel mostra o modo Original, e ele
    // desenha as páginas com o pdfjs. Um .docx TEM arquivo guardado, mas não
    // há o que desenhar — o painel abriria em branco, e o imprimir mandaria
    // para o Chromium um formato que ele não renderiza.
    hasOriginal:
      found.doc.kind === 'pdf' && (await sessionDocumentFile(sessionId, docId)) !== null,
  }
}

/**
 * Páginas do PDF renderizadas em imagem, com o trecho citado marcado.
 *
 * É o que permite grifar DENTRO do PDF: o visualizador nativo do Chromium é
 * fechado — não dá para alcançar o conteúdo dele nem a sua busca — então a
 * página é desenhada por nós e o destaque vai por cima, nas coordenadas que o
 * pdfjs dá para o texto.
 *
 * Em lote porque cada chamada abre uma janela oculta: pedir de cinco em cinco
 * é uma janela a cada cinco páginas, em vez de uma por página rolada.
 */
export async function renderSessionPages(
  sessionId: string,
  docId: string,
  from: number,
  count: number,
  options: { scale?: number; includeText?: boolean; includeOutline?: boolean } = {},
): Promise<{
  total: number
  outline: PdfOutlineItem[]
  pages: { page: number; dataUrl: string; width: number; height: number; items: PdfTextItem[] }[]
} | null> {
  const found = await readSessionDocument(sessionId, docId)
  if (!found || found.doc.kind !== 'pdf') return null
  const bytes = await readSessionDocumentBytes(sessionId, docId)
  if (!bytes) return null

  const start = Math.max(1, Math.round(from) || 1)
  const wanted: number[] = []
  for (let n = start; n < start + Math.min(Math.max(count, 1), MAX_RASTER_PAGES); n += 1) wanted.push(n)

  const rendered = await rasterizePdf(bytes, {
    pages: wanted,
    scale: options.scale,
    includeText: options.includeText,
    includeOutline: options.includeOutline,
  })
  return {
    total: rendered.total,
    outline: rendered.outline,
    pages: rendered.pages.map((p) => ({
      page: p.pageNumber,
      dataUrl: `data:image/png;base64,${p.png.toString('base64')}`,
      width: p.width,
      height: p.height,
      items: p.items,
    })),
  }
}

/**
 * Manda a fonte para a impressora. Só as que têm arquivo: um trecho colado
 * não tem nada para imprimir além do texto, que sai pelo baixar.
 */
export async function printSessionDocument(
  sessionId: string,
  docId: string,
): Promise<{ ok: boolean; error?: string }> {
  const source = await sessionDocumentFile(sessionId, docId)
  if (!source) return { ok: false, error: 'Este tipo de fonte não tem arquivo para imprimir.' }
  // Mesma regra do documento da galeria: o Chromium só pagina PDF. Com .docx
  // ele baixaria o arquivo em vez de abrir o diálogo de impressão.
  if (source.ext !== 'pdf') {
    return { ok: false, error: 'Só PDF pode ser impresso daqui. Baixe o arquivo e imprima pelo Word.' }
  }
  const found = await readSessionDocument(sessionId, docId)
  return printFile(source.path, found?.doc.filename)
}

/**
 * Salva a fonte em disco, onde o usuário escolher.
 *
 * Nas fontes com arquivo é uma cópia do ORIGINAL, byte a byte — não do que o
 * painel mostra. Nas que nasceram texto (trecho colado, página baixada) o
 * texto extraído é o que existe, e sai como .txt.
 */
export async function exportSessionDocument(
  sessionId: string,
  docId: string,
): Promise<{ ok: true; path: string } | { ok: false; canceled?: true; error?: string }> {
  const found = await readSessionDocument(sessionId, docId)
  if (!found) return { ok: false, error: 'Documento não encontrado.' }
  const source = await sessionDocumentFile(sessionId, docId)
  const ext = source?.ext ?? 'txt'
  const base = found.doc.filename.replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]/g, '-')

  const result = await dialog.showSaveDialog({
    defaultPath: `${base || 'documento'}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }

  try {
    if (source) await fsp.copyFile(source.path, result.filePath)
    else {
      await fsp.writeFile(
        result.filePath,
        found.extracted.pages.map((p) => p.text).join('\n\n'),
        'utf8',
      )
    }
    return { ok: true, path: result.filePath }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Bytes originais do documento — a fonte tipada do sheet_query, a fonte da
 * rasterização do pdf_view_page e a base da cópia editada do docx_edit. null
 * quando o tipo não guarda original ou quando o anexo é anterior a esta cópia
 * existir; nesse caso quem chama avisa em vez de devolver resultado errado.
 */
export async function readSessionDocumentBytes(
  sessionId: string,
  docId: string,
): Promise<Buffer | null> {
  if (!SAFE_ID.test(docId)) return null
  const dir = dirForId(await scopesOf(sessionId), docId)
  if (!dir) return null
  try {
    return await fsp.readFile(path.join(dir, `${docId}.bin`))
  } catch {
    return null
  }
}

/** Adiciona um arquivo pela aba Fontes, sem passar por uma mensagem. */
export async function addSessionDocument(
  sessionId: string,
  filename: string,
  bytes: Buffer,
  shared: boolean,
): Promise<{ ok: true; doc: SessionDocument } | { ok: false; error: string }> {
  const kind = documentKindOf(filename)
  if (!kind) {
    return { ok: false, error: `${filename}: só PDF, DOCX e planilhas entram como fonte.` }
  }
  try {
    const { doc } = await saveSessionDocument(sessionId, bytes, filename, kind, { shared })
    return { ok: true, doc }
  } catch (err) {
    return { ok: false, error: `${filename}: ${(err as Error).message}` }
  }
}

/**
 * Adiciona um trecho de texto colado como fonte.
 *
 * Existe porque nem toda fonte é arquivo: o e-mail que alguém mandou, o
 * pedaço de uma norma, a transcrição de uma reunião. Colar isso numa mensagem
 * jogaria o texto inteiro no contexto de todo turno; como fonte, ele é
 * paginado e lido sob demanda igual aos outros.
 */
export async function addSessionText(
  sessionId: string,
  title: string,
  text: string,
  shared: boolean,
): Promise<{ ok: true; doc: SessionDocument } | { ok: false; error: string }> {
  const content = text.trim()
  if (!content) return { ok: false, error: 'O texto está vazio.' }
  try {
    const { doc } = await saveSessionDocument(
      sessionId,
      Buffer.from(content, 'utf8'),
      title.trim() || 'Texto colado',
      'text',
      { shared },
    )
    return { ok: true, doc }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Adiciona uma página da web como fonte: baixa, extrai o texto legível e
 * guarda como qualquer outro documento.
 *
 * É uma FOTOGRAFIA do momento, não um link vivo — a página pode mudar depois,
 * e o que o agente lê continua sendo o que foi capturado. Isso é o que se
 * quer numa fonte de pesquisa (a citação tem que continuar valendo), e é o
 * oposto do webfetch, que serve justamente para ver o estado atual.
 */
export async function addSessionUrl(
  sessionId: string,
  url: string,
  shared: boolean,
): Promise<{ ok: true; doc: SessionDocument } | { ok: false; error: string }> {
  try {
    const page = await fetchReadablePage(url)
    if (!page.text.trim()) {
      return { ok: false, error: `${url}: a página não trouxe texto legível (pode depender de JavaScript).` }
    }
    const { doc } = await saveSessionDocument(
      sessionId,
      Buffer.from(page.text, 'utf8'),
      page.title,
      'web',
      { shared, sourceUrl: url },
    )
    return { ok: true, doc }
  } catch (err) {
    return { ok: false, error: `${url}: ${(err as Error).message}` }
  }
}

/**
 * Move um documento entre os dois escopos — é o arrastar de uma área para a
 * outra na aba Fontes.
 *
 * O id MUDA junto com o escopo (doc5 → src2), porque é o prefixo que diz onde
 * o arquivo mora. Um id citado antes deixa de resolver; o agente reencontra
 * por doc_list, que é o que a mensagem de erro manda fazer.
 */
export async function setSessionDocumentShared(
  sessionId: string,
  docId: string,
  shared: boolean,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!SAFE_ID.test(docId)) return { ok: false, error: 'Id inválido.' }
  if (isShared(docId) === shared) return { ok: true, id: docId }
  const scopes = await scopesOf(sessionId)
  if (!scopes.folder) {
    return { ok: false, error: 'Esta conversa não está em nenhuma pasta, então não há com quem compartilhar.' }
  }
  const from = dirForId(scopes, docId)
  const target = shared ? (scopes.folder as string) : scopes.session
  if (!from) return { ok: false, error: 'Documento não encontrado.' }

  const stored = await readStoredAt(from, docId)
  if (!stored) return { ok: false, error: 'Documento não encontrado.' }

  const id = await allocateId(target, shared ? 'src' : 'doc')
  const dir = scopeDir(target)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ ...stored, id, shared }),
    'utf8',
  )
  // O original acompanha: sem ele o documento perderia o sheet_query, a
  // rasterização e a edição preservando formatação só por ter mudado de área.
  await fsp.rename(path.join(from, `${docId}.bin`), path.join(dir, `${id}.bin`)).catch(() => {})
  await fsp.rm(path.join(from, `${docId}.json`), { force: true })
  notifyDocumentsChanged()
  return { ok: true, id }
}

/** Remove um documento do escopo em que ele estiver. */
export async function removeSessionDocument(sessionId: string, docId: string): Promise<boolean> {
  if (!SAFE_ID.test(docId)) return false
  const dir = dirForId(await scopesOf(sessionId), docId)
  if (!dir) return false
  try {
    await fsp.rm(path.join(dir, `${docId}.json`))
  } catch {
    return false
  }
  await fsp.rm(path.join(dir, `${docId}.bin`), { force: true })
  notifyDocumentsChanged()
  return true
}

async function scopeUsage(scope: string | null): Promise<number> {
  if (!scope || !SAFE_SCOPE.test(scope)) return 0
  const dir = scopeDir(scope)
  let total = 0
  try {
    for (const file of await fsp.readdir(dir)) {
      const stat = await fsp.stat(path.join(dir, file)).catch(() => null)
      if (stat?.isFile()) total += stat.size
    }
  } catch {
    return 0
  }
  return total
}

/**
 * Apaga os anexos de um chat excluído — só o escopo PRÓPRIO dele.
 *
 * O que ele tiver promovido a fonte da pasta fica: aquilo foi declarado corpus
 * e é compartilhado com as outras conversas, que não podem perder a base de
 * pesquisa porque um dos participantes saiu.
 */
export async function deleteSessionDocuments(sessionId: string): Promise<void> {
  if (!SAFE_SCOPE.test(sessionId)) return
  await fsp.rm(scopeDir(sessionId), { recursive: true, force: true })
}

/**
 * Apaga as fontes de uma pasta excluída. Os chats voltam para a raiz com os
 * anexos próprios intactos, mas o escopo da pasta deixa de ser alcançável por
 * qualquer um deles — manter os arquivos seria exatamente o lixo órfão que
 * esta limpeza existe para evitar.
 */
export async function deleteFolderDocuments(folderId: string): Promise<void> {
  if (!SAFE_SCOPE.test(folderId)) return
  await fsp.rm(scopeDir(`folder-${folderId}`), { recursive: true, force: true })
}

/**
 * Avisa as janelas que o conjunto de fontes mudou. A aba Fontes é a única
 * assinante: sem isto, anexar um PDF pela conversa deixaria a aba aberta ao
 * lado mostrando a lista velha.
 *
 * Emitido direto daqui, como o artifact:updated do media.ts, para não criar
 * ciclo de import com a camada de broadcast.
 */
function notifyDocumentsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('documents:changed')
  }
}
