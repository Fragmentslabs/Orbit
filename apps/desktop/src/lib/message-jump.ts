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

/** Rola até a mensagem (centralizada) e pisca o destaque. */
export async function scrollToMessage(messageId: string): Promise<void> {
  const el = await revealMessage(messageId)
  if (!el) return
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  const prevBg = el.style.backgroundColor
  const prevTransition = el.style.transition
  el.style.transition = "background-color 0.4s ease"
  el.style.backgroundColor = "var(--accent)"
  setTimeout(() => {
    el.style.backgroundColor = prevBg
    setTimeout(() => {
      el.style.transition = prevTransition
    }, 400)
  }, 700)
}
