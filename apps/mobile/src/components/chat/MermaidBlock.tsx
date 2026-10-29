/**
 * Diagrama mermaid desenhado dentro do chat.
 *
 * O desenho acontece num WebView, que não enxerga o bundle JS do React Native:
 * a lib vai embutida no documento (ver `lib/mermaid-html`), lida do asset do
 * próprio app uma vez por sessão (ver `lib/mermaid-source`). Enquanto ela não
 * chegou — e sempre que o desenho falhar — o bloco é o código-fonte, que é
 * exatamente o que se via antes deste componente existir.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CodeBlock } from '~/components/chat/CodeBlock'
import { PieceView } from '~/components/chat/PieceView'
import { buildMermaidHtml } from '~/lib/mermaid-html'
import { loadMermaidSource } from '~/lib/mermaid-source'
import { useThemeStore } from '~/stores/theme-store'

export interface MermaidBlockProps {
  /** O texto do diagrama, do jeito que veio na cerca. */
  code: string
  /** Cerca ainda chegando: desenhar agora daria um diagrama pela metade. */
  streaming?: boolean
}

/** Altura inicial antes de o diagrama dizer de quanto precisa. */
const INITIAL_HEIGHT = 220
const MIN_HEIGHT = 120
const MAX_HEIGHT = 720

/** O documento não avisa nada enquanto não termina de montar; sem um prazo, um
 *  desenho travado deixaria o spinner girando para sempre. */
const LOAD_TIMEOUT_MS = 10_000

interface WebMessage {
  type?: string
  height?: number
}

export function MermaidBlock({ code, streaming = false }: MermaidBlockProps) {
  const { t } = useTranslation()
  const resolved = useThemeStore((s) => s.resolved)
  const [lib, setLib] = useState<string | null>(null)
  const [libFailed, setLibFailed] = useState(false)
  const [height, setHeight] = useState(INITIAL_HEIGHT)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    void loadMermaidSource().then((source) => {
      if (!alive) return
      if (source) setLib(source)
      else setLibFailed(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const html = useMemo(
    () => (lib ? buildMermaidHtml(code, { dark: resolved === 'dark', lib }) : ''),
    [code, lib, resolved],
  )

  useEffect(() => {
    if (streaming || failed || ready || !lib) return
    const timer = setTimeout(() => setFailed(true), LOAD_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [html, streaming, failed, ready, lib])

  const onMessage = useCallback((data: string) => {
    let message: WebMessage
    try {
      message = JSON.parse(data) as WebMessage
    } catch {
      return // mensagem fora do protocolo: não é nossa
    }
    if (message.type === 'height' && typeof message.height === 'number') {
      setHeight(Math.min(Math.max(Math.ceil(message.height), MIN_HEIGHT), MAX_HEIGHT))
      setReady(true)
      return
    }
    if (message.type === 'error') setFailed(true)
  }, [])

  // Sem desenho — cerca incompleta no stream, lib indisponível, sintaxe
  // inválida — o diagrama volta a ser o código-fonte. Nunca some da conversa.
  if (streaming || failed || libFailed || !lib || code.trim() === '') {
    return <CodeBlock code={code} language="mermaid" streaming={streaming} />
  }

  return (
    <PieceView
      html={html}
      title={t('parts.mermaid.title')}
      height={height}
      onMessage={onMessage}
      onError={() => setFailed(true)}
      loadingLabel={t('parts.mermaid.loading')}
      errorLabel={t('parts.mermaid.error')}
    />
  )
}
