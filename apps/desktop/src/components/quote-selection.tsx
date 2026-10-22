import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import { Quote, SquareIcon, Volume2Icon } from "lucide-react"
import { readTtsEngine, readTtsPrefs, useSpeak, useTtsStatus } from "@/src/hooks/use-speak"
import { useAppSettings } from "@/src/stores/app-settings"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Selecionar um trecho num visualizador e mandá-lo para o chat.
 *
 * Fica aqui, e não dentro de cada visualizador, porque o gesto é o mesmo em
 * todos: selecionou, aparece o botão, virou chip no compositor. O que muda de
 * um para o outro é só COMO se descobre a página e a linha do trecho — e isso
 * entra por `resolve`, que cada visualizador implementa do seu jeito (o
 * documento vivo em Markdown não implementa: ele não tem página).
 *
 * O botão é renderizado em portal com posição fixa porque a caixa da seleção
 * vem em coordenadas de viewport: dentro do contêiner ele seria cortado pelo
 * overflow do painel, que é justamente onde o texto rola.
 */

export interface QuoteAnchor {
  page?: number
  fromLine?: number
  toLine?: number
}

const MAX_TEXT = 4_000

export function QuoteSelection({
  containerRef,
  kind,
  docId,
  name,
  resolve,
  readAloud = false,
}: {
  containerRef: RefObject<HTMLElement | null>
  /** O que o agente pode fazer com o id — ver DocumentQuotePayload. */
  kind: "document" | "source"
  docId: string
  name: string
  /**
   * Onde o trecho está no documento. Ausente = cita só o texto.
   *
   * Recebe o texto já extraído da seleção porque nem todo visualizador
   * descobre a posição pelo DOM: no PDF desenhado a única pista é o próprio
   * texto, procurado de volta nas linhas da página.
   */
  resolve?: (range: Range, text: string) => QuoteAnchor
  /**
   * Oferece "Ler trecho" ao lado do "Citar no chat".
   *
   * É opt-in: quem não pede continua com a barra de um botão só. O documento
   * em Markdown pede, porque lá a leitura em voz alta é o mesmo gesto da
   * conversa; num visualizador que já tem os seus controles de fala a decisão
   * é outra.
   */
  readAloud?: boolean
}) {
  const { t } = useTranslation()
  const addQuote = usePanelStore((s) => s.addQuote)
  // As mesmas regras do botão de fala da mensagem inteira (messages/speak-action):
  // some com o TTS desligado nas preferências e, sem o modelo baixado, também
  // não aparece — aqui não há espaço para o atalho que leva às Preferências, e
  // um botão que só falha é pior que um botão ausente.
  const voice = useAppSettings((s) => (s.settings as unknown as { voice?: unknown }).voice)
  const prefs = useMemo(() => readTtsPrefs(voice), [voice])
  const engine = useMemo(() => readTtsEngine(voice), [voice])
  const { ready, known } = useTtsStatus(prefs.enabled, engine)
  // `known: false` = ninguém respondeu (main antigo ou sem motor): não bloqueia.
  const canSpeak = readAloud && prefs.enabled && (!known || ready)
  const { speak, stop, speaking } = useSpeak()
  // Guardado em ref para o chamador poder passar uma arrow inline sem que o
  // listener seja reassinado a cada render.
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve
  const [pending, setPending] = useState<
    { x: number; y: number; text: string; anchor: QuoteAnchor } | null
  >(null)

  const capture = useCallback(() => {
    const container = containerRef.current
    const selection = window.getSelection()
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setPending(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) {
      setPending(null)
      return
    }
    const text = selection.toString().trim()
    if (!text) {
      setPending(null)
      return
    }
    const rect = range.getBoundingClientRect()
    setPending({
      x: rect.left + rect.width / 2,
      y: rect.top,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
      anchor: resolveRef.current?.(range, text) ?? {},
    })
  }, [containerRef])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // O botão nasce quando a seleção TERMINA (mouseup/keyup), não a cada
    // mexida do cursor: durante o arrasto ele ficaria pulando junto.
    container.addEventListener("mouseup", capture)
    container.addEventListener("keyup", capture)
    // ...e some assim que a seleção se desfaz, por clique ou por rolagem que
    // a leve para fora da tela.
    const onSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) setPending(null)
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => {
      container.removeEventListener("mouseup", capture)
      container.removeEventListener("keyup", capture)
      document.removeEventListener("selectionchange", onSelectionChange)
    }
  }, [containerRef, capture])

  if (!pending) return null

  return createPortal(
    <div
      style={{ left: pending.x, top: pending.y - 8 }}
      className="fixed z-[999] flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md"
    >
      {canSpeak && (
        <button
          type="button"
          // Sem o preventDefault o clique desfaz a seleção e a barra some no
          // meio da fala — com ele o mesmo trecho pode ser interrompido logo
          // em seguida.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (speaking) stop()
            else speak(pending.text, { voice: prefs.voice, lang: prefs.lang, speed: prefs.speed, engine })
          }}
          className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium hover:bg-accent"
        >
          {speaking ? <SquareIcon className="size-3" /> : <Volume2Icon className="size-3" />}
          {speaking ? t("voice.tts.stop") : t("sources.speak")}
        </button>
      )}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          addQuote({ kind, docId, name, text: pending.text, ...pending.anchor })
          window.getSelection()?.removeAllRanges()
          setPending(null)
        }}
        className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium hover:bg-accent"
      >
        <Quote className="size-3" />
        {t("sources.quoteInChat")}
      </button>
    </div>,
    document.body,
  )
}
