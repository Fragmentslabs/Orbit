/**
 * Citação de documento na resposta: `#orbit-source/<docId>/p<pagina>L<linha>`.
 *
 * O par gerador/leitor vive em dois processos — o main monta o endereço
 * (document-pages.ts) e o renderer o interpreta aqui. Separado do componente
 * para poder ser testado sem React, porque a quebra desse contrato é
 * silenciosa: um endereço que não casa vira link comum, que não abre nada e
 * não avisa.
 */

export const SOURCE_HREF = /^#orbit-source\/([a-z]+\d+)\/p(\d+)(?:L(\d+)(?:-(\d+))?)?$/i

export interface SourceRef {
  docId: string
  page: number
  fromLine?: number
  toLine?: number
}

export function parseSourceHref(href: string): SourceRef | null {
  const match = SOURCE_HREF.exec(href.trim())
  if (!match) return null
  return {
    docId: match[1],
    page: Number(match[2]),
    fromLine: match[3] ? Number(match[3]) : undefined,
    toLine: match[4] ? Number(match[4]) : undefined,
  }
}

/**
 * Converte a citação no formato antigo (`orbit-source://…`) para o atual.
 *
 * O formato antigo era um esquema próprio, e o markdown da resposta passa por
 * rehype-sanitize + rehype-harden: o sanitizador apaga o href de todo
 * protocolo fora de http/https/mailto/tel, e o harden então marca o link sem
 * endereço como "[blocked]". Era isso que aparecia na conversa.
 *
 * As respostas já gravadas guardam o texto como foi escrito, então trocar o
 * formato só conserta as próximas — esta reescrita, feita na hora de
 * renderizar, é o que devolve o clique às mensagens antigas sem reescrever o
 * histórico em disco.
 */
export function rescueLegacyCitations(markdown: string): string {
  return markdown.includes('](orbit-source://')
    ? markdown.replaceAll('](orbit-source://', '](#orbit-source/')
    : markdown
}
