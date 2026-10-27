import fsp from 'node:fs/promises'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { DOCX_PAGE_BREAK_MARK } from '@shared/page-breaks'
import { docxHeadFoot, withHeadFoot } from './docx-headfoot'
import { sanitizeDocxHtml } from './docx-sanitize'
import { sessionDocumentFile } from './session-documents'

/**
 * Um .docx anexado, visto como documento.
 *
 * O painel sabia desenhar só PDF: o .docx era guardado, mas aberto ele virava
 * a lista de linhas do texto extraído — título, tabela e negrito achatados
 * numa coluna numerada, como se fosse código. O mammoth, que já está no
 * projeto para a prévia dos documentos do agente, converte o arquivo em HTML
 * com a estrutura dele: títulos, listas, tabelas, ênfase e as imagens
 * embutidas.
 *
 * O HTML vem de um arquivo de fora, então sai daqui limpo: só o que o mammoth
 * escreve, sem manipulador de evento, e com todo link apontando para fora do
 * app — um `javascript:` no hyperlink de um .docx não pode virar código
 * rodando no painel.
 *
 * Paginação: o .docx não guarda páginas, mas guarda as quebras que o autor
 * forçou — e eram elas que sumiam, deixando o documento inteiro numa folha só.
 * As duas funções abaixo as preservam: `normalizePageBreaks` faz o Word dizer a
 * quebra do jeito que o mammoth entende, e `markPageBreaks` deixa a marca no
 * HTML para o painel cortar as folhas.
 */

/** A quebra de run, que é a forma que o mammoth lê (o Ctrl+Enter do Word). */
const PAGE_BREAK_RUN = '<w:r><w:br w:type="page"/></w:r>'

/**
 * O Word guarda a quebra de página de duas formas: `<w:br w:type="page"/>`
 * dentro de um run (Ctrl+Enter) e `<w:pageBreakBefore/>` nas propriedades do
 * parágrafo ("quebrar página antes"). O mammoth entende a primeira e **ignora a
 * segunda em silêncio** — que é justamente a que o nosso gerador de .docx
 * escreve, e a que o Word usa quando a quebra é propriedade do parágrafo.
 *
 * Aqui a marcação do pPr vira a quebra de run correspondente, no começo do
 * mesmo parágrafo: o Word desenha a mesma coisa, e o arquivo original não é
 * tocado. Zip que não abre volta como estava.
 */
export async function normalizePageBreaks(buffer: Buffer): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(buffer)
    const file = zip.file('word/document.xml')
    if (!file) return buffer
    const xml = await file.async('string')
    if (!xml.includes('<w:pageBreakBefore')) return buffer
    const fixed = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
      if (!paragraph.includes('<w:pageBreakBefore')) return paragraph
      const withoutBreak = paragraph.replace(/<w:pageBreakBefore\s*\/>/g, '')
      // O fim do pPr, se houver: a quebra entra logo depois, como primeiro run.
      const head = /^<w:p(?:\s[^>]*)?>(?:\s*<w:pPr>[\s\S]*?<\/w:pPr>)?/.exec(withoutBreak)
      if (!head) return withoutBreak
      return `${head[0]}${PAGE_BREAK_RUN}${withoutBreak.slice(head[0].length)}`
    })
    if (fixed === xml) return buffer
    zip.file('word/document.xml', fixed)
    return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
  } catch {
    // Pacote estranho: segue com o original, que ainda abre no painel.
    return buffer
  }
}

type DocNode = {
  type?: string
  breakType?: string
  value?: string
  children?: DocNode[]
}

function isPageBreak(node: DocNode): boolean {
  return node.type === 'break' && node.breakType === 'page'
}

/** O parágrafo que carrega só a marca — é nele que o painel corta a folha. */
function breakParagraph(): DocNode {
  return {
    type: 'paragraph',
    children: [{ type: 'run', children: [{ type: 'text', value: DOCX_PAGE_BREAK_MARK }] }],
  }
}

/**
 * Um parágrafo cortado nos pontos de quebra, com a marca num parágrafo próprio.
 * O corte é no MODELO, antes do HTML, para nunca partir uma tag ao meio.
 */
function splitParagraph(paragraph: DocNode): DocNode[] {
  const out: DocNode[] = []
  let runs: DocNode[] = []
  const flush = () => {
    if (runs.length > 0) out.push({ ...paragraph, children: runs })
    runs = []
  }
  for (const run of paragraph.children ?? []) {
    if (run.type !== 'run' || !Array.isArray(run.children) || !run.children.some(isPageBreak)) {
      runs.push(run)
      continue
    }
    let pieces: DocNode[] = []
    for (const inner of run.children) {
      if (!isPageBreak(inner)) {
        pieces.push(inner)
        continue
      }
      if (pieces.length > 0) runs.push({ ...run, children: pieces })
      pieces = []
      flush()
      out.push(breakParagraph())
    }
    if (pieces.length > 0) runs.push({ ...run, children: pieces })
  }
  flush()
  return out.length > 0 ? out : [paragraph]
}

/**
 * As quebras viram um parágrafo marcador no documento que o mammoth converte.
 * Só os parágrafos do corpo são cortados: quebra dentro de célula de tabela não
 * existe no Word, e cortar ali partiria a tabela em duas.
 */
export function markPageBreaks(document: DocNode): DocNode {
  if (!Array.isArray(document.children)) return document
  const children: DocNode[] = []
  for (const child of document.children) {
    if (child.type === 'paragraph') children.push(...splitParagraph(child))
    else children.push(child)
  }
  return { ...document, children }
}

/**
 * Um arquivo .docx em HTML limpo, venha de onde vier. As duas origens — o
 * anexo da conversa e o documento que o agente editou — passam por aqui, para
 * nenhuma delas ficar sem o saneamento.
 */
export async function docxFileToHtml(filePath: string): Promise<{ html: string } | null> {
  try {
    const buffer = await fsp.readFile(filePath)
    const { value } = await mammoth.convertToHtml(
      { buffer: await normalizePageBreaks(buffer) },
      { transformDocument: (document) => markPageBreaks(document as DocNode) },
    )
    // O mammoth só converte o corpo; cabeçalho e rodapé vêm à parte.
    return { html: sanitizeDocxHtml(withHeadFoot(value, await docxHeadFoot(buffer))) }
  } catch {
    // Arquivo corrompido ou num formato que o mammoth não lê: o painel cai
    // para o modo Texto, que continua funcionando com o que foi extraído.
    return null
  }
}

export async function renderSessionDocx(
  sessionId: string,
  docId: string,
): Promise<{ html: string } | null> {
  const file = await sessionDocumentFile(sessionId, docId)
  if (!file || file.ext !== 'docx') return null
  try {
    return await docxFileToHtml(file.path)
  } catch {
    // Arquivo corrompido ou num formato que o mammoth não lê: o painel cai
    // para o modo Texto, que continua funcionando com o que foi extraído.
    return null
  }
}
