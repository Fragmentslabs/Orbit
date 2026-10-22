/**
 * Pular para uma mensagem do chat.
 *
 * A lista do chat só monta as últimas mensagens (janela — ver ChatMessages em
 * chat-view.tsx), então uma mensagem antiga pode não existir no DOM. Quem quer
 * rolar até ela (busca, navegador de mensagens, galeria de mídia) pede aqui:
 * cada lista montada registra um "revelador" que estende a própria janela até
 * a mensagem, e só depois o elemento é procurado.
 */

/** Devolve true quando a lista tem a mensagem (e já pediu para mostrá-la). */
type Revealer = (messageId: string) => boolean

const revealers = new Set<Revealer>()

export function registerMessageRevealer(revealer: Revealer): () => void {
  revealers.add(revealer)
  return () => {
    revealers.delete(revealer)
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function findMessageElement(messageId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`)
}

/** Quadros de espera pelo elemento (~2s): cobre o chat que ainda está
 *  carregando o histórico, como depois de trocar de sessão pela galeria. */
const MAX_FRAMES = 120

/**
 * Garante a mensagem montada e devolve o elemento dela (null se não apareceu).
 * Os reveladores são consultados a cada quadro até algum reconhecer a
 * mensagem — a lista certa pode ainda nem ter montado.
 */
export async function revealMessage(messageId: string): Promise<HTMLElement | null> {
  let owned = false
  for (let frame = 0; frame < MAX_FRAMES; frame += 1) {
    if (!owned) {
      for (const reveal of revealers) {
        if (reveal(messageId)) owned = true
      }
    }
    const el = findMessageElement(messageId)
    if (el) {
      // O elemento acabou de entrar: espera o layout do que entrou junto
      // acima dele, senão a rolagem mira uma posição que ainda vai mudar.
      await nextFrame()
      return el
    }
    await nextFrame()
  }
  return null
}

export interface ScrollToMessageOptions {
  /** Pisca um anel na mensagem. A busca do chat desliga: lá o destaque é o
   *  próprio termo grifado (ver highlightTextIn). */
  flash?: boolean
}

/** Rola até a mensagem (centralizada) e, por padrão, pisca um anel nela. */
export async function scrollToMessage(
  messageId: string,
  options: ScrollToMessageOptions = {},
): Promise<HTMLElement | null> {
  const el = await revealMessage(messageId)
  if (!el) return null
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  if (options.flash !== false) flashMessage(el)
  return el
}

/**
 * Pisca um anel em volta da mensagem.
 *
 * Antes isto pintava o `background-color` do elemento — e o wrapper da
 * mensagem ocupa a linha inteira, então o resultado era um retângulo quadrado
 * atrás da bolha arredondada. O anel marca o mesmo lugar sem cobrir o que a
 * mensagem tem dentro, e segue o raio do elemento que o recebe.
 */
function flashMessage(el: HTMLElement): void {
  const surface = el.querySelector<HTMLElement>("[data-msg-surface]") ?? el
  const prevOutline = surface.style.outline
  const prevOffset = surface.style.outlineOffset
  const prevTransition = surface.style.transition
  surface.style.transition = "outline-color 0.4s ease"
  surface.style.outline = "2px solid var(--primary)"
  surface.style.outlineOffset = "3px"
  window.setTimeout(() => {
    surface.style.outlineColor = "transparent"
  }, 600)
  window.setTimeout(() => {
    surface.style.outline = prevOutline
    surface.style.outlineColor = ""
    surface.style.outlineOffset = prevOffset
    surface.style.transition = prevTransition
  }, 1000)
}

/* ------------------------------------------------------------------ */
/* Grifo do termo buscado                                              */
/* ------------------------------------------------------------------ */

/**
 * A busca do chat NÃO pinta a mensagem: um fundo no wrapper vira bloco
 * quadrado atrás da bolha e, pior, não aponta o que casou com a busca. Com a
 * CSS Custom Highlight API (Chromium — é o que roda no Electron) o destaque
 * são só os caracteres do termo: os ranges vão para `CSS.highlights` e o
 * desenho vem da regra `::highlight(orbit-search-hit)` no index.css.
 * Registrar e apagar é uma linha, então o grifo não sobrevive ao fechamento
 * da busca.
 */
const SEARCH_HIGHLIGHT = "orbit-search-hit"

/** Teto do texto varrido: uma resposta gigante não precisa ser grifada toda. */
const MAX_WALK = 200_000

const COMBINING = /[\u0300-\u036f]/g

type HighlightCtor = new (...ranges: Range[]) => object

interface HighlightRegistry {
  set: (name: string, highlight: object) => void
  delete: (name: string) => void
}

function highlightRegistry(): HighlightRegistry | null {
  const registry = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
  return registry && typeof registry.set === "function" ? registry : null
}

function highlightConstructor(): HighlightCtor | null {
  const ctor = (globalThis as unknown as { Highlight?: unknown }).Highlight
  return typeof ctor === "function" ? (ctor as HighlightCtor) : null
}

/** Apaga o grifo da busca. Chamado ao fechar a busca e antes de cada grifo novo. */
export function clearTextHighlight(): void {
  highlightRegistry()?.delete(SEARCH_HIGHLIGHT)
}

/** Minúscula e sem acento — a mesma comparação que a busca faz (normalizeText). */
function foldChar(ch: string): string {
  return ch.normalize("NFD").replace(COMBINING, "").toLowerCase()
}

function fold(text: string): string {
  let out = ""
  for (const ch of text) out += foldChar(ch)
  return out
}

/**
 * Texto dobrado + o mapa de volta para os índices do original (um caractere
 * acentuado pode virar letras de tamanho diferente depois do NFD, então o
 * offset do DOM não é o offset da busca).
 */
function foldWithMap(text: string): { folded: string; starts: number[]; ends: number[] } {
  const chars: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const ch of text) {
    const next = offset + ch.length
    for (const folded of foldChar(ch)) {
      chars.push(folded)
      starts.push(offset)
      ends.push(next)
    }
    offset = next
  }
  return { folded: chars.join(""), starts, ends }
}

/**
 * Grifa `query` dentro do elemento da mensagem e devolve quantos trechos
 * foram marcados. Substitui o grifo anterior: só o resultado atual fica
 * aceso. Devolve 0 quando não há o que grifar (ou quando o runtime não tem a
 * API — a rolagem continua valendo).
 */
export function highlightTextIn(el: HTMLElement, query: string): number {
  clearTextHighlight()
  const registry = highlightRegistry()
  const HighlightCtor = highlightConstructor()
  const term = fold(query.trim())
  if (!registry || !HighlightCtor || !term) return 0

  const ranges: Range[] = []
  let walked = 0
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT
      // Rótulo de leitor de tela e script não são conteúdo visível.
      if (node.parentElement?.closest("script, style, .sr-only")) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text
    const value = textNode.nodeValue ?? ""
    walked += value.length
    if (walked > MAX_WALK) break
    const { folded, starts, ends } = foldWithMap(value)
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
      const start = starts[at]
      const end = ends[at + term.length - 1]
      if (start === undefined || end === undefined || end <= start) continue
      const range = document.createRange()
      range.setStart(textNode, start)
      range.setEnd(textNode, end)
      ranges.push(range)
    }
  }
  if (ranges.length === 0) return 0
  registry.set(SEARCH_HIGHLIGHT, new HighlightCtor(...ranges))
  return ranges.length
}
