import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { extractDocument, type DocumentKind, type ExtractedDocument } from './documents'

/**
 * Documentos anexados a uma sessão de chat.
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
 */

export interface SessionDocument {
  /** Id curto usado pelo modelo nas tools (doc1, doc2…) — legível e barato. */
  id: string
  sessionId: string
  filename: string
  kind: DocumentKind
  totalPages: number
  totalChars: number
  truncated: boolean
  createdAt: number
}

interface StoredDocument extends SessionDocument {
  pages: ExtractedDocument['pages']
}

/** Só aceita o id que nós mesmos geramos — nada de path traversal vindo de
 *  uma chamada de tool que o modelo inventou. */
const SAFE_DOC_ID = /^doc[0-9]+$/
const SAFE_SESSION = /^[a-zA-Z0-9_-]+$/

function sessionDir(sessionId: string): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'session-docs', sessionId)
}

async function readStored(sessionId: string, docId: string): Promise<StoredDocument | null> {
  if (!SAFE_SESSION.test(sessionId) || !SAFE_DOC_ID.test(docId)) return null
  try {
    const raw = await fsp.readFile(path.join(sessionDir(sessionId), `${docId}.json`), 'utf8')
    const parsed = JSON.parse(raw) as StoredDocument
    return Array.isArray(parsed.pages) ? parsed : null
  } catch {
    return null
  }
}

/** Documentos da sessão, em ordem de anexação. */
export async function listSessionDocuments(sessionId: string): Promise<SessionDocument[]> {
  if (!SAFE_SESSION.test(sessionId)) return []
  let files: string[]
  try {
    files = (await fsp.readdir(sessionDir(sessionId))).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const docs: SessionDocument[] = []
  for (const file of files) {
    const stored = await readStored(sessionId, file.replace(/\.json$/, ''))
    if (stored) docs.push({ ...stored, pages: undefined } as SessionDocument)
  }
  return docs.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Extrai e guarda um documento anexado. Retorna o registro sem as páginas —
 * quem chama monta o trecho de abertura com `readSessionPages`.
 */
export async function saveSessionDocument(
  sessionId: string,
  bytes: Buffer,
  filename: string,
  kind: DocumentKind,
): Promise<{ doc: SessionDocument; pages: ExtractedDocument['pages'] }> {
  const extracted = await extractDocument(bytes, kind)
  const existing = await listSessionDocuments(sessionId)
  const doc: SessionDocument = {
    id: `doc${existing.length + 1}`,
    sessionId,
    filename,
    kind,
    totalPages: extracted.totalPages,
    totalChars: extracted.totalChars,
    truncated: extracted.truncated,
    createdAt: Date.now(),
  }
  const stored: StoredDocument = { ...doc, pages: extracted.pages }
  await fsp.mkdir(sessionDir(sessionId), { recursive: true })
  await fsp.writeFile(path.join(sessionDir(sessionId), `${doc.id}.json`), JSON.stringify(stored), 'utf8')

  // Planilha guarda também o ARQUIVO ORIGINAL. O texto extraído serve para
  // ler, mas não para calcular: ali o valor já vem formatado como a planilha
  // o exibe, e somar a partir disso obrigaria a reparsear "1.234,56" — que é
  // exatamente onde mora o erro silencioso de locale. O sheet_query relê os
  // bytes com os tipos originais. Só planilha: num PDF não há o que calcular.
  if (kind === 'spreadsheet') {
    await fsp.writeFile(path.join(sessionDir(sessionId), `${doc.id}.bin`), bytes)
  }
  return { doc, pages: extracted.pages }
}

/** Reconstrói o ExtractedDocument de um documento guardado. */
export async function readSessionDocument(
  sessionId: string,
  docId: string,
): Promise<{ doc: SessionDocument; extracted: ExtractedDocument } | null> {
  const stored = await readStored(sessionId, docId)
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
 * Busca nos documentos da sessão. Devolve no MÁXIMO uma ocorrência por
 * página: o objetivo é localizar onde ler, não trazer o texto — trazer todas
 * as ocorrências recriaria, por outro caminho, o despejo que esta camada
 * existe para evitar.
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
 * Bytes originais de uma planilha anexada — a fonte tipada do sheet_query.
 * null quando o documento não é planilha ou foi anexado antes desta cópia
 * existir (nesse caso a consulta avisa em vez de calcular errado).
 */
export async function readSessionDocumentBytes(
  sessionId: string,
  docId: string,
): Promise<Buffer | null> {
  if (!SAFE_SESSION.test(sessionId) || !SAFE_DOC_ID.test(docId)) return null
  try {
    return await fsp.readFile(path.join(sessionDir(sessionId), `${docId}.bin`))
  } catch {
    return null
  }
}

/** Apaga os documentos de uma sessão (chat excluído). */
export async function deleteSessionDocuments(sessionId: string): Promise<void> {
  if (!SAFE_SESSION.test(sessionId)) return
  await fsp.rm(sessionDir(sessionId), { recursive: true, force: true })
}
