/**
 * Mermaid diagram drawn inside the chat.
 *
 * The drawing happens in a WebView, which cannot see the JS bundle of React Native:
 * the lib goes embedded in the document (see `lib/mermaid-html`), read from the asset of the
 * app itself once per session (see `lib/mermaid-source`). Until it
 * arrives — and whenever the drawing fails — the block is the source code, which is
 * exactly what was seen before this component existed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CodeBlock } from '~/components/chat/CodeBlock'
import { PieceView } from '~/components/chat/PieceView'
import { buildMermaidHtml } from '~/lib/mermaid-html'
import { loadMermaidSource } from '~/lib/mermaid-source'
import { useThemeStore } from '~/stores/theme-store'

export interface MermaidBlockProps {
  /** The diagram text, the way it came in the fence. */
  code: string
  /** Fence still arriving: drawing now would give a half diagram. */
  streaming?: boolean
}

/** Initial height before the diagram says how much it needs. */
const INITIAL_HEIGHT = 220
const MIN_HEIGHT = 120
const MAX_HEIGHT = 720

/** The document warns nothing until it finishes mounting; without a deadline, a
 *  stuck drawing would leave the spinner spinning forever. */
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
    () =>
      lib
        ? buildMermaidHtml(code, { dark: resolved === 'dark', lib, failMessage: t('mermaid.failed') })
        : '',
    [code, lib, resolved, t],
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
      return // message outside the protocol: not ours
    }
    if (message.type === 'height' && typeof message.height === 'number') {
      setHeight(Math.min(Math.max(Math.ceil(message.height), MIN_HEIGHT), MAX_HEIGHT))
      setReady(true)
      return
    }
    if (message.type === 'error') setFailed(true)
  }, [])

  // No drawing — incomplete fence in the stream, lib unavailable, invalid
  // syntax — the diagram goes back to being the source code. It never vanishes from the conversation.
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
