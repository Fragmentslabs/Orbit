import type { Element, ElementContent, Root, RootContent } from "hast"

/**
 * A figura sozinha vira `<figure>` com `<figcaption>`, usando o `alt` como
 * legenda.
 *
 * Isto DIVERGE do Markdown padrão de propósito: `alt` é texto alternativo, não
 * legenda, e nenhum renderizador comum (GitHub, Obsidian, VS Code) o exibe. A
 * troca vale porque a pré-visualização de arquivo é um leitor de documentação,
 * onde a captura de tela quase sempre precisa de um rótulo — e é por isso que
 * ela não vale para a conversa, onde o `alt` vem do modelo.
 *
 * A legenda é `aria-hidden`: ela repete o `alt`, que o leitor de tela já
 * anuncia. Sem isso, o mesmo texto seria lido duas vezes.
 */

/** Extensão de imagem no fim do texto — sinal de que o alt é um nome de
 *  arquivo, não uma descrição. */
const LOOKS_LIKE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i

/**
 * Rótulo genérico, sozinho ou com um número atrás ("image", "figura 2").
 *
 * Ancorado nas duas pontas de propósito: "Tela" é genérico e não vira legenda,
 * mas "Tela de seleção de projetos" é uma descrição e vira.
 */
const GENERIC_ALT =
  /^(image|img|imagem|figure|figura|foto|print|screenshot|captura|tela|diagrama|diagram)[\s_-]*\d*$/i

/** O alt foi escrito para ser LIDO, ou é só um preenchimento? */
export function isCaptionWorthy(alt: string): boolean {
  const text = alt.trim()
  if (!text) return false
  if (LOOKS_LIKE_FILE.test(text)) return false
  return !GENERIC_ALT.test(text)
}

function isBlankText(node: ElementContent): boolean {
  return node.type === "text" && node.value.trim() === ""
}

function isImage(node: ElementContent): node is Element {
  return node.type === "element" && node.tagName === "img"
}

/** A figura e a legenda, no lugar do parágrafo que só tinha a imagem. */
function toFigure(img: Element, caption: string): Element {
  return {
    type: "element",
    tagName: "figure",
    properties: {},
    children: [
      img,
      {
        type: "element",
        tagName: "figcaption",
        // Repete o alt, que o leitor de tela já anuncia.
        properties: { ariaHidden: "true" },
        children: [{ type: "text", value: caption }],
      },
    ],
  }
}

function convert(node: Root | Element): void {
  node.children = node.children.map((child) => {
    if (child.type !== "element") return child
    convert(child)
    if (child.tagName !== "p") return child
    // Só a imagem SOZINHA vira figura: uma no meio de um texto é ilustração
    // inline, e uma fileira delas (os selos de um README) não são três
    // figuras com três legendas.
    const meaningful = child.children.filter((c) => !isBlankText(c))
    if (meaningful.length !== 1 || !isImage(meaningful[0])) return child
    const img = meaningful[0]
    const alt = typeof img.properties?.alt === "string" ? img.properties.alt : ""
    return isCaptionWorthy(alt) ? toFigure(img, alt) : child
  }) as RootContent[] & ElementContent[]
}

/**
 * Roda no FIM do pipeline, depois do sanitize e do harden: os elementos que
 * criamos são nossos e não precisam passar pelo sanitizador, e a imagem já
 * chegou aqui na forma final (a bloqueada virou outra coisa e não é mais uma
 * `img`, então não ganha legenda).
 */
export function rehypeFigureCaption() {
  return (tree: Root): void => convert(tree)
}
