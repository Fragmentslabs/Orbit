import { app, BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { StorageKeys, type SessionInfo } from '@shared/chat'
import { extractDocument, type DocumentKind, type ExtractedDocument } from './documents'
import { documentKindOf } from './document-pages'
import { readJson } from './storage'

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
  options: { shared?: boolean } = {},
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
      for (const line of page.text.split('\n')) {
        if (!pattern.test(line)) continue
        hits.push({
          docId: id,
          filename: found.doc.filename,
          page: page.num,
          line: line.trim().slice(0, 250),
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
