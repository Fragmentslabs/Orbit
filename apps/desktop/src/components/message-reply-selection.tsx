import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import { MessageSquareQuoteIcon, SquareIcon, Volume2Icon } from "lucide-react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { replyExcerpt, type MessageReplyQuote } from "@shared/chat"
import { readTtsEngine, readTtsPrefs, useSpeak, useTtsStatus } from "@/src/hooks/use-speak"
import { useAppSettings } from "@/src/stores/app-settings"
import { useMessageReply } from "@/src/stores/message-reply"

/**
 * Selecionar um trecho de uma mensagem e responder só ele.
 *
 * Mesmo gesto do QuoteSelection dos visualizadores de documento (selecionou,
 * aparece o botão), com uma diferença de fundo: lá o trecho vira ANEXO do
 * documento; aqui ele vira resposta, e entra no texto enviado. Por isso o
 * botão daqui não escolhe página nem linha — escolhe a mensagem.
 *
 * Precisa estar montado dentro do <Conversation> para ler o elemento de
 * rolagem do contexto, e é ele que delimita a área válida: sem essa checagem,
 * uma seleção no visualizador de arquivo (com o chat aberto ao lado) ofereceria
 * responder uma mensagem que não tem nada a ver com o que foi marcado.
 *
 * O botão vai em portal com posição fixa porque a caixa da seleção vem em
 * coordenadas de viewport: dentro do contêiner ele seria cortado pelo overflow
 * da conversa, que é justamente onde o texto rola.
 *
 * Com o TTS ligado aparece um segundo botão, que lê SÓ o trecho marcado. As
 * regras são as do botão de fala da mensagem inteira (`SpeakAction`): some com o
 * TTS desligado nas preferências e, sem o modelo baixado, também não aparece —
 * aqui não há espaço para o atalho que leva às Preferências, e um botão que só
 * falha é pior que um botão ausente.
 */
export function MessageReplySelection({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const { scrollRef } = useStickToBottomContext()
  const setReply = useMessageReply((s) => s.setReply)
  const [pending, setPending] = useState<{ x: number; y: number; quote: MessageReplyQuote } | null>(null)
  // O tipo compartilhado pode ainda não trazer o bloco `voice` (outro worker):
  // lê defensivamente do store, com os padrões do app.
  const voice = useAppSettings((s) => (s.settings as unknown as { voice?: unknown }).voice)
  const prefs = useMemo(() => readTtsPrefs(voice), [voice])
  const engine = useMemo(() => readTtsEngine(voice), [voice])
  const { ready, known } = useTtsStatus(prefs.enabled, engine)
  // `known: false` = ninguém respondeu (main antigo ou sem motor): não bloqueia.
  const speakEnabled = prefs.enabled && (!known || ready)
  const { speak, stop, speaking } = useSpeak()

  const capture = useCallback(() => {
    const container = scrollRef.current
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
    // Papel lido do DOM: a seleção pode estar em qualquer parte da mensagem
    // (texto, markdown, bloco de código), e o ancestral mais próximo com o
    // atributo diz de qual mensagem ela é. Seleção que atravessa duas
    // mensagens cai no contêiner, sem o atributo, e não oferece nada.
    const node = range.commonAncestorContainer
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
    const role = element?.closest("[data-msg-role]")?.getAttribute("data-msg-role")
    if (role !== "user" && role !== "assistant") {
      setPending(null)
      return
    }
    const text = replyExcerpt(selection.toString())
    if (!text) {
      setPending(null)
      return
    }
    const rect = range.getBoundingClientRect()
    setPending({ x: rect.left + rect.width / 2, y: rect.top, quote: { role, text } })
  }, [scrollRef])

  useEffect(() => {
    // O botão nasce quando a seleção TERMINA (mouseup/keyup), não a cada
    // mexida do cursor: durante o arrasto ele ficaria pulando junto.
    document.addEventListener("mouseup", capture)
    document.addEventListener("keyup", capture)
    // ...e some assim que a seleção se desfaz.
    const onSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) setPending(null)
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => {
      document.removeEventListener("mouseup", capture)
      document.removeEventListener("keyup", capture)
      document.removeEventListener("selectionchange", onSelectionChange)
    }
  }, [capture])

  if (!pending) return null

  return createPortal(
    <div
      style={{ left: pending.x, top: pending.y - 8 }}
      className="fixed z-[999] flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md"
    >
      {speakEnabled && (
        <button
          type="button"
          // Sem o preventDefault o clique desfaz a seleção e o botão some no
          // meio da fala — com ele o menu fica onde está e o mesmo trecho pode
          // ser interrompido logo em seguida.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (speaking) stop()
            else speak(pending.quote.text, { voice: prefs.voice, lang: prefs.lang, speed: prefs.speed, engine })
          }}
          className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium hover:bg-accent"
        >
          {speaking ? <SquareIcon className="size-3" /> : <Volume2Icon className="size-3" />}
          {speaking ? t("voice.tts.stop") : t("reply.speak")}
        </button>
      )}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setReply(sessionId, pending.quote)
          window.getSelection()?.removeAllRanges()
          setPending(null)
        }}
        className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium hover:bg-accent"
      >
        <MessageSquareQuoteIcon className="size-3" />
        {t("reply.excerpt")}
      </button>
    </div>,
    document.body,
  )
}
