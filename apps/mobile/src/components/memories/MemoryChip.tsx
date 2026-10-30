/**
 * Chip of a memory cited in the conversation — the mobile mirror of the desktop
 * memory-citation, adapted to what the platform has: there is no hover, so the tap opens
 * the sheet with the summary (see MemorySheet).
 *
 * It is a <Text> and not a <Pressable> on purpose: it lives INSIDE the paragraph
 * of the markdown, and only a nested Text flows in the middle of the sentence.
 */
import { memo, useEffect, useMemo } from 'react'
import { Text } from 'react-native'
import { useMemoryStore } from '~/stores/memory-store'
import { useMemorySheetStore } from '~/stores/memory-sheet-store'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/** Label short enough to fit in the middle of a sentence. */
const MAX_LABEL = 34

function shortLabel(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > MAX_LABEL ? `${clean.slice(0, MAX_LABEL).trimEnd()}…` : clean
}

export const MemoryChip = memo(function MemoryChip({
  memoryId,
  label,
  size = 14,
}: {
  memoryId: string
  /** Text of the link written by the model; when it is only the id, the memory title wins. */
  label?: string
  /** Size of the surrounding text — the chip comes in two points smaller. */
  size?: number
}) {
  const open = useMemorySheetStore((s) => s.open)
  const index = useMemoryStore((s) => s.index)
  const ensureIndex = useMemoryStore((s) => s.ensureIndex)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const memory = useMemo(() => index.find((m) => m.id === memoryId), [index, memoryId])

  // Index not loaded yet in this conversation: the chip is born with the id and is
  // renamed when the list arrives (ensureIndex fetches once per session).
  useEffect(() => {
    if (!memory) void ensureIndex()
  }, [memory, ensureIndex])

  const text = useMemo(() => {
    const written = label?.trim()
    if (written && written !== memoryId) return shortLabel(written)
    const fromMemory = memory?.title ?? memory?.summary ?? memory?.text ?? ''
    return fromMemory ? shortLabel(fromMemory) : memoryId
  }, [label, memory, memoryId])

  return (
    <Text
      onPress={() => open(memoryId)}
      suppressHighlighting
      style={{
        fontSize: Math.max(10, size - 2),
        fontWeight: '600',
        color: memory ? tokens.primary : tokens.mutedForeground,
        backgroundColor: memory ? withAlpha(tokens.primary, 0.16) : tokens.muted,
        borderRadius: 4,
        paddingHorizontal: 4,
        overflow: 'hidden',
      }}
    >
      {text}
    </Text>
  )
})
