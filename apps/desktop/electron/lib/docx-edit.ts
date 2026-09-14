import { createRequire } from 'node:module'

/**
 * Edição de um .docx EXISTENTE preservando a formatação.
 *
 * A estratégia é cópia cirúrgica, não regeneração: partimos dos bytes
 * originais e trocamos só o texto pedido dentro do `word/document.xml`. Tudo
 * o mais — estilos, fontes, cabeçalho, rodapé, imagens, numeração — continua
 * sendo exatamente o do arquivo de origem, porque nunca foi tocado.
 *
 * A alternativa barata (ler com mammoth, virar Markdown, regerar pelo nosso
 * renderizador) perderia justamente a formatação, que é o motivo de editar um
 * documento existente em vez de escrever um novo.
 *
 * O OBSTÁCULO REAL é a fragmentação de runs. O Word quebra uma frase em vários
 * `<w:r>` por causa de marcas de revisão e corretor ortográfico, então uma
 * frase visível no documento quase nunca existe como string contígua no XML —
 * procurar por ela ingenuamente não acha nada. Aqui a busca é feita sobre o
 * texto CONCATENADO do parágrafo, com um índice de volta para (run, posição),
 * e a troca é costurada entre os runs afetados.
 */

const _require = createRequire(import.meta.url)

export interface Replacement {
  find: string
  replace: string
  /** Trocar todas as ocorrências (padrão: só a primeira). */
  all?: boolean
}

export interface EditResult {
  bytes: Buffer
  /** Quantas substituições cada entrada produziu, na ordem recebida. */
  applied: number[]
}

interface RunText {
  /** O elemento <w:t> cujo texto entra na concatenação. */
  node: Element
  start: number
  end: number
}

type XmlDoc = Document

function textNodes(paragraph: Element): RunText[] {
  const out: RunText[] = []
  let offset = 0
  // Só <w:t> conta como texto do parágrafo. <w:delText> (texto já marcado como
  // excluído numa revisão) fica de fora de propósito: ele não aparece no
  // documento aceito, e editá-lo mudaria um histórico, não o conteúdo.
  const nodes = paragraph.getElementsByTagName('w:t')
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i)
    if (!node) continue
    const text = node.textContent ?? ''
    out.push({ node: node as unknown as Element, start: offset, end: offset + text.length })
    offset += text.length
  }
  return out
}

/**
 * Escreve `value` no <w:t>, cuidando do espaço.
 *
 * Sem `xml:space="preserve"`, o Word descarta espaço no início e no fim do
 * run — a frase sai com as palavras coladas, e o erro só aparece ao abrir o
 * arquivo.
 */
function setText(node: Element, value: string): void {
  node.textContent = value
  if (/^\s|\s$/.test(value)) node.setAttribute('xml:space', 'preserve')
}

/**
 * Aplica uma substituição no parágrafo. O texto novo entra INTEIRO no primeiro
 * run da ocorrência, herdando a formatação dali; os runs seguintes perdem a
 * parte que casou. É o comportamento que preserva o visual quando a frase
 * atravessa formatações diferentes (metade em negrito, por exemplo).
 */
function replaceInParagraph(
  paragraph: Element,
  find: string,
  replacement: string,
  all: boolean,
): number {
  if (find === '') return 0
  let count = 0

  for (;;) {
    // Reconstrói o índice a cada volta: a substituição anterior mudou os
    // tamanhos dos runs, então as posições antigas não valem mais.
    const runs = textNodes(paragraph)
    if (runs.length === 0) return count
    const full = runs.map((r) => r.node.textContent ?? '').join('')
    const at = full.indexOf(find)
    if (at < 0) return count

    const end = at + find.length
    for (const run of runs) {
      if (run.end <= at || run.start >= end) continue
      const text = run.node.textContent ?? ''
      const from = Math.max(0, at - run.start)
      const to = Math.min(text.length, end - run.start)
      const isFirst = run.start <= at && run.end > at
      setText(run.node, text.slice(0, from) + (isFirst ? replacement : '') + text.slice(to))
    }
    count += 1
    if (!all) return count

    // Substituição que contém o procurado ("X" → "XY") repetiria para sempre.
    if (replacement.includes(find)) return count
  }
}

/** Aplica as substituições no documento inteiro, parágrafo a parágrafo. */
export function applyReplacements(doc: XmlDoc, replacements: Replacement[]): number[] {
  const paragraphs = doc.getElementsByTagName('w:p')
  return replacements.map((r) => {
    let total = 0
    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs.item(i)
      if (!p) continue
      total += replaceInParagraph(p as unknown as Element, r.find, r.replace, r.all ?? false)
      if (total > 0 && !r.all) break
    }
    return total
  })
}

/**
 * Abre o .docx, aplica as substituições e devolve um arquivo NOVO. O original
 * nunca é tocado — quem chama decide onde gravar.
 */
export async function editDocx(original: Buffer, replacements: Replacement[]): Promise<EditResult> {
  const JSZip = _require('jszip') as typeof import('jszip')
  const { DOMParser, XMLSerializer } = _require('@xmldom/xmldom') as typeof import('@xmldom/xmldom')

  const zip = await JSZip.loadAsync(original)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('Arquivo .docx inválido: word/document.xml não encontrado.')

  const xml = await entry.async('string')
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as XmlDoc
  const applied = applyReplacements(doc, replacements)

  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc as never))
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { bytes, applied }
}

/** Texto corrido do documento, para o agente localizar o que quer trocar. */
export async function readDocxParagraphs(original: Buffer): Promise<string[]> {
  const JSZip = _require('jszip') as typeof import('jszip')
  const { DOMParser } = _require('@xmldom/xmldom') as typeof import('@xmldom/xmldom')
  const zip = await JSZip.loadAsync(original)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('Arquivo .docx inválido: word/document.xml não encontrado.')
  const doc = new DOMParser().parseFromString(await entry.async('string'), 'text/xml')
  const paragraphs = doc.getElementsByTagName('w:p')
  const out: string[] = []
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs.item(i)
    if (!p) continue
    out.push(textNodes(p as unknown as Element).map((r) => r.node.textContent ?? '').join(''))
  }
  return out
}
