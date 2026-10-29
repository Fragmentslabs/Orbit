import { defaultRemarkPlugins } from "streamdown"
import type { Plugin, PluggableList } from "unified"

/**
 * Quebra de linha simples vira <br> — a regra dos comentários do GitHub.
 *
 * O CommonMark junta as linhas de um parágrafo num texto só: "primeira
 * ideia\nsegunda ideia" sai como "primeira ideia segunda ideia". Numa resposta
 * longa de modelo isso passa; numa mensagem de chat APAGA informação — quem
 * escreve uma ideia por linha está separando ideias, não escrevendo parágrafo.
 *
 * A regra vale só onde a quebra é texto: parágrafo e título. Lista, tabela,
 * bloco de código e citação já carregam a quebra na ESTRUTURA do markdown e
 * não passam por aqui — dentro de um ``` de código uma linha por linha
 * continuaria sendo uma linha por linha de qualquer jeito.
 *
 * É o `remark-breaks` sem a dependência: a transformação são vinte linhas e
 * evitam versão presa a um plugin que não temos de outra forma.
 */

/** O mínimo de um nó mdast que esta transformação toca — sem @types/mdast. */
export interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
}

/** Um nó de texto com quebras vira texto + `break` + texto… */
function splitSoftBreaks(node: MdastNode): MdastNode[] {
  if (node.type !== "text" || typeof node.value !== "string") return [node]
  if (!node.value.includes("\n")) return [node]

  const chunks = node.value.split("\n")
  // Quebra no FIM do texto é o fim do parágrafo, não uma linha em branco.
  while (chunks.length > 1 && chunks[chunks.length - 1] === "") chunks.pop()

  const out: MdastNode[] = []
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) out.push({ type: "break" })
    if (chunk) out.push({ type: "text", value: chunk })
  }
  return out
}

/** A transformação em si — exportada para o teste exercitá-la na árvore. */
export function applyChatLineBreaks(tree: MdastNode): void {
  const walk = (node: MdastNode): void => {
    if (!node.children) return
    if (node.type === "paragraph" || node.type === "heading") {
      node.children = node.children.flatMap(splitSoftBreaks)
      return
    }
    node.children.forEach(walk)
  }
  walk(tree)
}

export const remarkChatLineBreaks: Plugin = () => (tree) =>
  applyChatLineBreaks(tree as unknown as MdastNode)

/** O pipeline do streamdown (GFM) + a quebra de linha do chat.
 *
 * `remarkPlugins` no streamdown SUBSTITUI os defaults em vez de somar — daí
 * partir de `defaultRemarkPlugins` aqui, para tabela, autolink e afins
 * continuarem valendo. */
export const chatRemarkPlugins: PluggableList = [
  ...Object.values(defaultRemarkPlugins),
  remarkChatLineBreaks,
]
