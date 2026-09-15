import path from 'node:path'

/**
 * Lógica pura da camada de documentos: que arquivo é documento, como quebrar
 * em páginas, como rotular e como anunciar um trecho ao modelo.
 *
 * Separado do documents.ts porque aquele depende do `app` do Electron (o
 * diretório do cache) e não carrega fora do main process — mesma divisão que
 * a memória já faz entre domínio puro e repositório. É aqui que moram as
 * decisões testáveis.
 */

/**
 * Tipos de fonte. Os tres primeiros vem de um ARQUIVO binario; `text`
 * (trecho colado) e `web` (pagina baixada) ja nascem como texto e existem
 * so no painel de fontes — nao ha extensao que os traga do disco, e por
 * isso eles nao entram no EXTENSIONS: fazer .txt/.md virar documento
 * mudaria o `read` do modo codigo, que precisa continuar entregando esses
 * arquivos crus.
 */
export type DocumentKind = 'pdf' | 'docx' | 'spreadsheet' | 'text' | 'web'

export interface DocumentPage {
  /** 1-indexado. Em planilha é o índice da aba; em DOCX, do bloco sintético. */
  num: number
  text: string
  /** Rótulo da página quando ela tem nome próprio (aba da planilha). */
  label?: string
}

export interface ExtractedDocument {
  kind: DocumentKind
  pages: DocumentPage[]
  totalPages: number
  totalChars: number
  /** true quando o documento foi cortado por exceder os limites de segurança. */
  truncated: boolean
}

const EXTENSIONS: Record<string, DocumentKind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'spreadsheet',
  '.xls': 'spreadsheet',
  '.ods': 'spreadsheet',
  '.csv': 'spreadsheet',
}

/**
 * Teto global do texto extraído — barreira contra arquivo patológico, não
 * limite de uso: 8MB de texto é da ordem de milhares de páginas. Existe
 * porque o extrator roda no main process; um arquivo malformado que
 * explodisse em memória travaria o app inteiro.
 */
export const MAX_TOTAL_CHARS = 8 * 1024 * 1024
/** Alvo de tamanho da página sintética do DOCX (~1 página impressa). */
export const DOCX_PAGE_CHARS = 3000

/** O arquivo é um documento que esta camada sabe ler? */
export function documentKindOf(filePath: string): DocumentKind | null {
  return EXTENSIONS[path.extname(filePath).toLowerCase()] ?? null
}

export function isDocumentPath(filePath: string): boolean {
  return documentKindOf(filePath) !== null
}

/**
 * Páginas sintéticas por tamanho, para o DOCX: o formato não guarda
 * paginação (o Word a calcula ao renderizar), então ela é inventada aqui.
 * A quebra respeita parágrafo — cortar no meio de uma frase deixaria o
 * trecho lido incompreensível justamente na borda, que é onde o agente mais
 * precisa entender se deve pedir a próxima página.
 */
export function paginateText(text: string, targetChars = DOCX_PAGE_CHARS): DocumentPage[] {
  const paragraphs = text.split(/\n{2,}/)
  const pages: DocumentPage[] = []
  let buffer = ''
  const flush = () => {
    if (!buffer.trim()) return
    pages.push({ num: pages.length + 1, text: buffer.trim() })
    buffer = ''
  }
  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length > targetChars) flush()
    buffer += (buffer ? '\n\n' : '') + paragraph
  }
  flush()
  return pages.length > 0 ? pages : [{ num: 1, text: '' }]
}

/**
 * Corta no teto global preservando PÁGINAS INTEIRAS: meia página no fim seria
 * pior que uma a menos, porque o agente não teria como saber que o trecho
 * está incompleto e citaria um texto mutilado como se fosse o original.
 */
export function capPages(
  pages: DocumentPage[],
  kind: DocumentKind,
  maxChars = MAX_TOTAL_CHARS,
): ExtractedDocument {
  let totalChars = 0
  let truncated = false
  const kept: DocumentPage[] = []
  for (const page of pages) {
    if (totalChars + page.text.length > maxChars) {
      truncated = true
      break
    }
    totalChars += page.text.length
    kept.push(page)
  }
  return { kind, pages: kept, totalPages: kept.length, totalChars, truncated }
}

/** Rótulo da página para exibir ao modelo ("p. 12" ou o nome da aba). */
export function pageLabel(page: DocumentPage, kind: DocumentKind): string {
  if (page.label) return `aba "${page.label}"`
  return kind === 'docx' ? `bloco ${page.num}` : `p. ${page.num}`
}

/**
 * Localizador compacto para resultado de busca. Carrega SEMPRE o número que
 * serve de `offset` na leitura, porque é isso que o agente precisa para ler
 * em volta do resultado — e o nome da aba quando existe, que é o handle útil
 * numa planilha.
 *
 * O tipo aparece no rótulo de propósito: dizer "p12" num DOCX faria o agente
 * citar ao usuário uma página que o Word não tem (a paginação ali é nossa,
 * sintética), e numa planilha faria "página 3" significar a terceira aba.
 */
export function pageLocator(page: DocumentPage, kind: DocumentKind): string {
  if (kind === 'spreadsheet') return `aba${page.num}${page.label ? ` (${page.label})` : ''}`
  return kind === 'docx' ? `bloco${page.num}` : `p${page.num}`
}

/**
 * Numera as linhas de uma página, no formato `12| texto`.
 *
 * É o que torna a citação VERIFICÁVEL: sem número de linha, o modelo só pode
 * apontar a página, e o usuário que clicar cai num bloco de texto tendo que
 * procurar sozinho o trecho citado — que é justamente a conferência que a
 * citação deveria dispensar. A numeração é por página (e não contínua no
 * documento) porque o localizador já carrega a página, e reiniciar mantém os
 * números curtos.
 *
 * O custo é da ordem de 5% do texto da página, pago em toda leitura; a troca é
 * deliberada.
 */
export function numberLines(text: string, width = 3): string {
  return text
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(width, ' ')}| ${line}`)
    .join('\n')
}

/**
 * Referência clicável de um trecho, no formato que o renderer entende.
 *
 * A linha entra no próprio endereço em vez de o trecho ir por texto livre:
 * texto livre exigiria que o modelo repetisse a citação sem errar um
 * caractere e ainda a codificasse na URL, e qualquer divergência deixaria o
 * destaque silenciosamente vazio.
 *
 * FRAGMENTO, e não um esquema próprio: o markdown da resposta passa por
 * rehype-sanitize, que aceita só http/https/mailto/tel e APAGA o href de
 * qualquer outro protocolo — o link chegava ao renderer sem endereço nenhum e
 * a citação virava um número inerte. Fragmento não tem protocolo, então
 * atravessa intacto; e, ao contrário de um domínio falso, no pior caso não
 * navega para lugar nenhum.
 */
export function sourceAnchor(docId: string, page: number, fromLine?: number, toLine?: number): string {
  const lines = fromLine ? `L${fromLine}${toLine && toLine > fromLine ? `-${toLine}` : ''}` : ''
  return `#orbit-source/${docId}/p${page}${lines}`
}

/** Janela de páginas pedida, normalizada contra os limites do documento. */
export function pageWindow(
  doc: ExtractedDocument,
  offset: number | undefined,
  limit: number | undefined,
  defaultPages: number,
  maxPages: number,
): { from: number; to: number; pages: DocumentPage[] } {
  const from = Math.min(Math.max(offset ?? 1, 1), Math.max(doc.totalPages, 1))
  const count = Math.min(Math.max(limit ?? defaultPages, 1), maxPages)
  const pages = doc.pages.slice(from - 1, from - 1 + count)
  return { from, to: from + Math.max(pages.length, 1) - 1, pages }
}

/**
 * Cabeçalho que acompanha TODA leitura parcial. Sem ele o modelo não tem como
 * saber que existe documento além do trecho — e responde como se tivesse lido
 * o todo, que é exatamente o erro que esta camada existe para evitar. Por isso
 * ele carrega o total e diz como continuar.
 */
export function documentHeader(
  filePath: string,
  doc: ExtractedDocument,
  shown: { from: number; to: number },
): string {
  const unit = doc.kind === 'spreadsheet' ? 'abas' : doc.kind === 'docx' ? 'blocos' : 'paginas'
  const range = shown.from === shown.to ? `${shown.from}` : `${shown.from}-${shown.to}`
  const rest =
    shown.to < doc.totalPages
      ? ` Ha mais documento: use offset=${shown.to + 1} para continuar, ou grep para localizar o trecho relevante.`
      : ''
  const cut = doc.truncated ? ' (documento cortado no limite de tamanho)' : ''
  return `<document path="${filePath}" kind="${doc.kind}" ${unit}="${doc.totalPages}" mostrando="${range}"${cut}>${rest}`
}
