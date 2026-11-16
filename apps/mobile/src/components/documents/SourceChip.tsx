/**
 * A `#orbit-source/...` citation inside the markdown. Like the memory chip it is a nested <Text>
 * (it flows in the middle of the sentence); tapping opens the document viewer at the cited page
 * and lines of the ACTIVE conversation, which is where the `docN` ids live.
 */
import { memo } from 'react'
import { Text } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { SourceRef } from '~/lib/document-source'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useDocumentViewerStore } from '~/stores/document-viewer-store'
import { useSessionStore } from '~/stores/session-store'
import { useThemeStore } from '~/stores/theme-store'

export const SourceChip = memo(function SourceChip({
  source,
  label,
  size = 14,
}: {
  source: SourceRef
  label: string
  size?: number
}) {
  const { t } = useTranslation()
  const open = useDocumentViewerStore((s) => s.open)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <Text
      accessibilityRole="link"
      accessibilityLabel={t('docViewer.cite', { id: source.docId })}
      onPress={() =>
        open({ kind: 'source', ...source, sessionId: useSessionStore.getState().activeSessionId ?? undefined })
      }
      suppressHighlighting
      style={{
        fontSize: Math.max(10, size - 2),
        color: tokens.primary,
        backgroundColor: withAlpha(tokens.primary, 0.12),
        borderRadius: 4,
        paddingHorizontal: 3,
      }}
    >
      {label}
    </Text>
  )
})
