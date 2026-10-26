import { computerRegistry, getComputerDriver, isComputerAvailable } from '../computer'
import { observe } from '../computer/observe'
import { isEnhanced, noteEnhanced, releaseEnhanced } from '../computer/session'
import { overlayOpenContext } from './open-context'
import { frontmostForeignApp } from './selection'

/**
 * O que o turno do painel do atalho (⇧⌘espaço) leva além da pergunta.
 *
 * Num pedido sobre a tela ("consegue ver minha tela?", "o que diz esse
 * erro?"), o Orbit lê a janela da frente como TEXTO antes do modelo responder
 * e manda junto da mensagem. Esperar o modelo decidir olhar falhava de dois
 * jeitos: um modelo rápido em modo de voz respondia sem chamar tool nenhuma
 * ("a captura não chega legível em mim" — repetindo uma tentativa antiga do
 * histórico), e mesmo quando chamava, era uma ida e volta a mais numa conversa
 * falada. A imagem continua no see_screen, para o que o texto não carrega.
 */

/** Enough for a dialog, an error or a page's visible text; a big app is cut, and the result says so. */
export const WINDOW_TEXT_NODES = 400

/**
 * Pedido sobre o que está na tela ou selecionado. Largo de propósito: ler a
 * janela custa milissegundos e algumas centenas de tokens; não ler quando era
 * preciso custa a resposta inventada.
 */
const SCREEN_INTENT =
  /\b(tela|telas|janela|vendo|v[eê]s|ver|olha|olhe|enxerga|aqui|isso|isto|erro|aparece|aparecendo|traduz|traduza|resume|resuma|leia|screen|window|see|look|error|translate|summari[sz]e|read)\b/i

export function wantsScreen(text: string): boolean {
  return SCREEN_INTENT.test(text)
}

/** Espera depois de ligar a árvore de um app Chromium/Electron: ela é montada de forma assíncrona. */
const ENHANCE_WAIT_MS = 450
/** Quanto tempo a árvore de um app Chromium/Electron fica ligada depois da última leitura. */
const ENHANCE_HOLD_MS = 45_000
/** Menos linhas com texto que isto = a janela não expõe conteúdo (só moldura, barra de título). */
const MIN_TEXT_LINES = 6

const releaseTimers = new Map<string, NodeJS.Timeout>()

/**
 * Apps Chromium/Electron (Claude, Chrome, VS Code, Slack…) só montam a árvore
 * de acessibilidade quando alguém a pede; sem isso a leitura devolvia só a
 * moldura da janela. A flag é ligada para ler e devolvida logo depois — deixar
 * ligada faz o app do usuário trabalhar a mais para sempre. Uma segunda
 * pergunta seguida aproveita a janela de 45 s.
 */
function scheduleRelease(sessionId: string): void {
  const previous = releaseTimers.get(sessionId)
  if (previous) clearTimeout(previous)
  releaseTimers.set(
    sessionId,
    setTimeout(() => {
      releaseTimers.delete(sessionId)
      releaseEnhanced(sessionId)
    }, ENHANCE_HOLD_MS),
  )
}

export type FrontWindowRead =
  | { text: string; poor: boolean }
  | { unavailable: string }

/** A janela da frente (atrás do painel) como texto, ou o motivo de não haver. `poor` = só moldura, sem conteúdo. */
export async function readFrontWindowText(sessionId: string): Promise<FrontWindowRead> {
  if (!isComputerAvailable()) {
    return { unavailable: 'Reading windows as text is not available here (it needs the Accessibility permission for Orbit).' }
  }
  try {
    const front = await frontmostForeignApp()
    const pid = overlayOpenContext()?.pid ?? front?.pid
    if (!pid) return { unavailable: 'There is no app window behind the panel to read.' }
    const result = await observe(getComputerDriver(), computerRegistry, {
      sessionId,
      app: String(pid),
      includeTree: true,
      includeScreenshot: false,
      maxNodes: WINDOW_TEXT_NODES,
      maxScreenshotEdge: 1280,
      enhance: true,
      enhanceWaitMs: isEnhanced(pid) ? 0 : ENHANCE_WAIT_MS,
    })
    if (result.tree?.enhanced) {
      noteEnhanced(sessionId, pid)
      scheduleRelease(sessionId)
    }
    const labelled = [...(result.record.bodies?.values() ?? [])].filter((body) => body.includes('"')).length
    return { text: result.text, poor: result.record.elements.size <= 2 || labelled < MIN_TEXT_LINES }
  } catch (err) {
    return { unavailable: `Could not read the window: ${err instanceof Error ? err.message : String(err)}.` }
  }
}

/**
 * A tela por imagem, descrita pelo modelo de visão — só para quando a leitura
 * em texto não trouxe conteúdo. Imagem é a exceção: demora e custa mais que
 * texto, mas aqui é o que sobra, e o modelo do atalho (rápido, de voz) não é
 * confiável para decidir sozinho chamar a tool depois.
 */
export async function describeFrontScreen(
  visionModel: { providerId: string; modelId: string },
  focus: string,
  language?: string,
): Promise<string | null> {
  const [{ captureScreenForOverlay }, { describeImage }] = await Promise.all([import('./capture'), import('../vision')])
  const shot = await captureScreenForOverlay().catch(() => null)
  if (!shot) return null
  return describeImage({
    model: visionModel,
    imageDataUrl: `data:${shot.mediaType};base64,${shot.data.toString('base64')}`,
    focus,
    language,
  })
}

/** O bloco que vai junto da mensagem do usuário quando o Orbit olhou a tela antes. */
export function prefetchedScreenBlock({ windowText, description }: { windowText?: string | null; description?: string | null }): string {
  const lines = [
    '[Orbit looked at the screen right before your reply — this counts as looking in THIS turn. Answer from it; do not say you cannot see or that the capture does not arrive. Call see_screen only if you need a closer look at how something LOOKS.]',
  ]
  if (windowText) lines.push('Window text (accessibility tree):', windowText)
  if (description) lines.push('A vision model looked at the screen image and described it:', description)
  return lines.join('\n')
}

/**
 * O painel do atalho não precisa da conversa inteira: é uma pergunta sobre o
 * agora. Mandar tudo custava ~180 mil tokens por turno falado e carregava
 * tentativas antigas que o modelo repetia em vez de olhar de novo. Fica o fio
 * recente — "e agora traduz isso" ainda aponta para o que acabou de ser dito.
 */
const OVERLAY_HISTORY_MS = 30 * 60_000
const OVERLAY_HISTORY_MAX = 12

export function recentOverlayHistory<T extends { createdAt: number }>(messages: T[], now = Date.now()): T[] {
  if (messages.length === 0) return messages
  const recent = messages.slice(-OVERLAY_HISTORY_MAX).filter((m) => now - m.createdAt <= OVERLAY_HISTORY_MS)
  const last = messages[messages.length - 1]
  // A mensagem do turno atual vai sempre, mesmo com o relógio estranho.
  return recent.length > 0 && recent[recent.length - 1] === last ? recent : [...recent.filter((m) => m !== last), last]
}
