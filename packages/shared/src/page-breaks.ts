/**
 * A quebra de página de um documento — a linha sozinha com `\pagebreak`.
 *
 * O PDF e o .docx gerados pelo app já tratam essa linha como quebra. Faltavam
 * as DUAS pontas que mostram o documento na tela: o canvas de Markdown, que
 * escrevia `\pagebreak` como texto, e o visualizador de .docx, que desenhava o
 * arquivo inteiro numa folha só. As duas leem daqui para não divergirem.
 */

/**
 * O que fica no HTML convertido no lugar de cada quebra explícita do .docx.
 *
 * O mammoth lê a quebra e não escreve NADA para ela; sem uma marca o painel não
 * teria como saber onde uma página acaba. A conversão põe a marca num parágrafo
 * próprio, então o corte não parte tag nenhuma ao meio.
 */
export const DOCX_PAGE_BREAK_MARK = '@@orbit:pagebreak@@'

const PAGE_BREAK_LINE = /^[ \t]*\\pagebreak[ \t]*$/m

/**
 * O Markdown em páginas, sem as linhas de instrução. Sem `\pagebreak` nenhum
 * devolve um item só — o documento é uma página, como sempre foi.
 */
export function splitOnPageBreaks(markdown: string): string[] {
  return markdown.split(PAGE_BREAK_LINE).map((part) => part.trim())
}

/** O HTML do .docx em folhas. Sem quebra explícita, uma folha só. */
export function splitDocxPages(html: string): string[] {
  const marker = new RegExp(`<p[^>]*>\\s*${DOCX_PAGE_BREAK_MARK}\\s*</p>`)
  return html.split(marker).map((part) => part.trim())
}
