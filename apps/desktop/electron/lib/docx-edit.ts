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

/**
 * Mudanças de ESTRUTURA — o que troca de texto não alcança: um item a mais na
 * lista, uma linha a mais na tabela, um parágrafo que sai.
 *
 * Todas partem de algo que já existe no arquivo e o CLONAM. É o mesmo princípio
 * da troca de texto: o parágrafo novo herda o estilo, a numeração, a fonte e o
 * recuo de um parágrafo de verdade do documento, e a linha nova herda bordas,
 * sombreamento e largura das colunas de uma linha de verdade da tabela. Nada é
 * desenhado do zero, e por isso nada destoa.
 *
 * Sem isto, pedir "acrescenta um item" não tinha ferramenta, e o recurso era
 * reescrever o documento inteiro em Markdown — que é exatamente o caminho que
 * joga fora a formatação que o usuário queria manter.
 */
export interface StructuralEdits {
  /** Parágrafos novos depois do parágrafo que contém `after`. */
  insert?: { after: string; text: string; like?: string }[]
  /** Remove o parágrafo que contém o texto. */
  remove?: { containing: string; all?: boolean }[]
  /** Linha nova numa tabela, depois da linha que contém `after`. */
  rows?: { after: string; cells: string[] }[]
  /** Remove a linha de tabela que contém o texto. */
  removeRows?: { containing: string }[]
}

export interface EditResult {
  bytes: Buffer
  /** Quantas substituições cada entrada produziu, na ordem recebida. */
  applied: number[]
  /** Por operação estrutural, na ordem recebida: quantas vezes foi aplicada.
   *  Zero é âncora não encontrada (ou remoção recusada, ver removeParagraph). */
  structural: { insert: number[]; remove: number[]; rows: number[]; removeRows: number[] }
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

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

function paragraphText(paragraph: Element): string {
  return textNodes(paragraph)
    .map((r) => r.node.textContent ?? '')
    .join('')
}

function allParagraphs(doc: XmlDoc): Element[] {
  const list = doc.getElementsByTagName('w:p')
  const out: Element[] = []
  for (let i = 0; i < list.length; i++) {
    const p = list.item(i)
    if (p) out.push(p as unknown as Element)
  }
  return out
}

function findParagraph(doc: XmlDoc, containing: string): Element | null {
  return allParagraphs(doc).find((p) => paragraphText(p).includes(containing)) ?? null
}

function ancestor(node: Element, tag: string): Element | null {
  let current = node.parentNode as Element | null
  while (current && current.nodeType === 1) {
    if (current.nodeName === tag) return current
    current = current.parentNode as Element | null
  }
  return null
}

function childrenNamed(node: Element, tag: string): Element[] {
  const out: Element[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as Element).nodeName === tag) out.push(child as Element)
  }
  return out
}

/**
 * Troca TODO o texto de um parágrafo, guardando a formatação do primeiro run
 * com texto. Os outros runs de texto saem; o que não é texto (marcadores de
 * revisão, bookmarks) fica onde estava.
 *
 * Parágrafo vazio não tem run para herdar: aí o run novo copia as
 * propriedades da marca de parágrafo (w:pPr/w:rPr), que é como o Word
 * formataria o que alguém digitasse ali.
 */
function setParagraphText(paragraph: Element, text: string): void {
  const doc = paragraph.ownerDocument
  const runs = Array.from({ length: paragraph.getElementsByTagName('w:r').length }, (_, i) =>
    paragraph.getElementsByTagName('w:r').item(i) as unknown as Element,
  ).filter(Boolean)
  const withText = runs.filter((r) => r.getElementsByTagName('w:t').length > 0)
  const keep = withText[0]

  for (const run of withText.slice(1)) run.parentNode?.removeChild(run)

  if (keep) {
    const ts = keep.getElementsByTagName('w:t')
    for (let i = ts.length - 1; i >= 1; i--) {
      const t = ts.item(i)
      t?.parentNode?.removeChild(t)
    }
    setText(ts.item(0) as unknown as Element, text)
    return
  }

  // O namespace do próprio parágrafo, e não uma constante: é ele que o resto
  // do documento usa, e um run num namespace diferente não seria o mesmo w:r.
  const ns = paragraph.namespaceURI || W_NS
  const run = doc.createElementNS(ns, 'w:r')
  const pPr = childrenNamed(paragraph, 'w:pPr')[0]
  const markRpr = pPr ? childrenNamed(pPr, 'w:rPr')[0] : undefined
  if (markRpr) run.appendChild(markRpr.cloneNode(true))
  const t = doc.createElementNS(ns, 'w:t')
  run.appendChild(t)
  setText(t as unknown as Element, text)
  paragraph.appendChild(run)
}

function insertParagraphs(
  doc: XmlDoc,
  after: string,
  text: string,
  like: string | undefined,
): number {
  const anchor = findParagraph(doc, after)
  if (!anchor) return 0
  const model = like ? findParagraph(doc, like) : anchor
  if (!model) return 0

  // Uma linha por parágrafo: \n no texto vira parágrafos irmãos, todos no
  // molde do modelo — é o "acrescenta estes três itens" de uma vez.
  let reference: Element = anchor
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const clone = model.cloneNode(true) as Element
    setParagraphText(clone, line)
    reference.parentNode?.insertBefore(clone, reference.nextSibling)
    reference = clone
  }
  return lines.length
}

/**
 * Remove o parágrafo. A exceção é o ÚLTIMO parágrafo de uma célula de tabela:
 * o formato exige ao menos um por célula, e o Word chama de corrompido o
 * arquivo que não tiver — aí o parágrafo fica e só o texto dele sai.
 */
function removeParagraph(doc: XmlDoc, containing: string, all: boolean): number {
  let count = 0
  for (const paragraph of allParagraphs(doc)) {
    if (!paragraphText(paragraph).includes(containing)) continue
    const cell = ancestor(paragraph, 'w:tc')
    if (cell && childrenNamed(cell, 'w:p').length <= 1) setParagraphText(paragraph, '')
    else paragraph.parentNode?.removeChild(paragraph)
    count += 1
    if (!all) break
  }
  return count
}

function insertRow(doc: XmlDoc, after: string, cells: string[]): number {
  const anchor = findParagraph(doc, after)
  const row = anchor ? ancestor(anchor, 'w:tr') : null
  if (!row) return 0

  const clone = row.cloneNode(true) as Element
  childrenNamed(clone, 'w:tc').forEach((cell, index) => {
    // Cada célula fica com um parágrafo só — o primeiro, que carrega o estilo
    // da coluna — e recebe o valor da posição dela.
    const paragraphs = childrenNamed(cell, 'w:p')
    for (const extra of paragraphs.slice(1)) cell.removeChild(extra)
    if (paragraphs[0]) setParagraphText(paragraphs[0], cells[index] ?? '')
  })
  row.parentNode?.insertBefore(clone, row.nextSibling)
  return 1
}

/** Remove a linha — menos a última da tabela, que deixaria uma tabela vazia. */
function removeRow(doc: XmlDoc, containing: string): number {
  const anchor = findParagraph(doc, containing)
  const row = anchor ? ancestor(anchor, 'w:tr') : null
  const table = row ? ancestor(row, 'w:tbl') : null
  if (!row || !table || childrenNamed(table, 'w:tr').length <= 1) return 0
  table.removeChild(row)
  return 1
}

/** Aplica as mudanças de estrutura, sobre o texto COMO ESTÁ no arquivo. */
export function applyStructural(doc: XmlDoc, edits: StructuralEdits): EditResult['structural'] {
  return {
    insert: (edits.insert ?? []).map((op) => insertParagraphs(doc, op.after, op.text, op.like)),
    rows: (edits.rows ?? []).map((op) => insertRow(doc, op.after, op.cells)),
    removeRows: (edits.removeRows ?? []).map((op) => removeRow(doc, op.containing)),
    remove: (edits.remove ?? []).map((op) => removeParagraph(doc, op.containing, op.all ?? false)),
  }
}

/**
 * Abre o .docx, aplica as mudanças e devolve um arquivo NOVO. O original
 * nunca é tocado — quem chama decide onde gravar.
 *
 * A estrutura vem ANTES do texto: as âncoras das inserções e remoções apontam
 * para o texto como ele está no arquivo, e uma troca feita antes mudaria o que
 * elas procuram. A ordem é fixa e está na descrição da tool, para o modelo
 * não ter que adivinhar.
 */
export async function editDocx(
  original: Buffer,
  replacements: Replacement[],
  structure: StructuralEdits = {},
): Promise<EditResult> {
  const JSZip = _require('jszip') as typeof import('jszip')
  const { DOMParser, XMLSerializer } = _require('@xmldom/xmldom') as typeof import('@xmldom/xmldom')

  const zip = await JSZip.loadAsync(original)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('Arquivo .docx inválido: word/document.xml não encontrado.')

  const xml = await entry.async('string')
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as XmlDoc
  const structural = applyStructural(doc, structure)
  const applied = applyReplacements(doc, replacements)

  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc as never))
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { bytes, applied, structural }
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
