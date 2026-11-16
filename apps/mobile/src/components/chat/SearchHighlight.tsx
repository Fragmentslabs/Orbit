import { createContext, useContext, type ReactNode } from 'react'
import { Text } from 'react-native'
import { splitByQuery } from '~/lib/chat-search'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useChatSearchStore } from '~/stores/chat-search-store'

/** Id of the message a subtree belongs to — lets deep renderers (markdown) know whether to paint. */
const MessageIdContext = createContext<string | null>(null)

export function MessageIdProvider({ id, children }: { id: string; children: ReactNode }) {
  return <MessageIdContext.Provider value={id}>{children}</MessageIdContext.Provider>
}

/** The term to paint for the enclosing message, or '' when it is not the active result. */
export function useActiveSearchTerm(): string {
  const id = useContext(MessageIdContext)
  return useChatSearchStore((s) => (id !== null && s.activeMessageId === id ? s.term : ''))
}

/**
 * Text with the active search term painted. Matches are nested <Text> spans, so it
 * works inside any parent Text (bold, italic, list items, table cells) and the
 * markdown renderer only needs to swap its leaf string for this component.
 * Returns the plain string when there is nothing to paint (the common case).
 */
export function Highlighted({ text }: { text: string }) {
  const term = useActiveSearchTerm()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  if (!term) return <>{text}</>
  const pieces = splitByQuery(text, term)
  if (pieces.length === 1 && !pieces[0].match) return <>{text}</>
  return (
    <>
      {pieces.map((p, i) =>
        p.match ? (
          <Text key={i} style={{ backgroundColor: withAlpha(tokens.primary, 0.4), color: tokens.foreground }}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </>
  )
}
