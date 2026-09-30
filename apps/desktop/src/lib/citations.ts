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

/** Texto de link que é só um número: [1], 1, [23]. */
const CITATION_TEXT = /^\[?\d{1,3}\]?$/
const WEB_HREF = /^https?:\/\//i

export type MarkdownLinkKind =
  | { kind: "source"; source: SourceRef }
  | { kind: "broken-source" }
  | { kind: "web-citation" }
  | { kind: "link" }

/**
 * O que um link do Markdown do assistente É, decidido num lugar só.
 *
 * Mora aqui, e não dentro do componente, porque foi ESTA decisão que derrubou
 * uma conversa inteira: todo link cujo texto era um número ia para o cartão de
 * citação da web, que monta uma URL a partir do href. Numa análise de código
 * o modelo escreveu "[1](#orbit-source/src?/p1)" — uma citação de documento
 * com id inventado — e o `new URL` desse href lançou durante a renderização.
 *
 * - source: citação de documento válida, abre a fonte no painel;
 * - broken-source: tem o formato de citação de documento mas não aponta para
 *   nada — vira texto, porque como link seria um clique morto;
 * - web-citation: número apontando para a web, ganha o cartão;
 * - link: todo o resto, inclusive "[1](src/app.ts)" e "[2](#secao)".
 */
export function classifyMarkdownLink(href: string | undefined, text: string): MarkdownLinkKind {
  if (!href) return { kind: "link" }
  const source = parseSourceHref(href)
  if (source) return { kind: "source", source }
  if (href.startsWith("#orbit-source/")) return { kind: "broken-source" }
  if (CITATION_TEXT.test(text.trim()) && WEB_HREF.test(href)) return { kind: "web-citation" }
  return { kind: "link" }
}
