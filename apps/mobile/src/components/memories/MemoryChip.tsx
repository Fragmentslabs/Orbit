/**
 * Chip de memória citada na conversa — o espelho mobile do memory-citation do
 * desktop, adaptado ao que a plataforma tem: não há hover, então o toque abre
 * a folha com o resumo (ver MemorySheet).
 *
 * É um <Text> e não um <Pressable> de propósito: ele vive DENTRO do parágrafo
 * do markdown, e só um Text aninhado flui no meio da frase.
 */
import { memo, useEffect, useMemo } from 'react'
import { Text } from 'react-native'
import { useMemoryStore } from '~/stores/memory-store'
import { useMemorySheetStore } from '~/stores/memory-sheet-store'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/** Rótulo curto o bastante para caber no meio de uma frase. */
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
  /** Texto do link escrita pelo modelo; quando é só o id, vale o título da memória. */
  label?: string
  /** Tamanho do texto em volta — o chip entra dois pontos menor. */
  size?: number
}) {
  const open = useMemorySheetStore((s) => s.open)
  const index = useMemoryStore((s) => s.index)
  const ensureIndex = useMemoryStore((s) => s.ensureIndex)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const memory = useMemo(() => index.find((m) => m.id === memoryId), [index, memoryId])

  // Índice ainda não carregado nesta conversa: o chip nasce com o id e é
  // renomeado quando a lista chega (ensureIndex busca uma vez por sessão).
  useEffect(() => {
    if (!memory) void ensureIndex()
  }, [memory, ensureIndex])

  const texto = useMemo(() => {
    const escrito = label?.trim()
    if (escrito && escrito !== memoryId) return shortLabel(escrito)
    const daMemoria = memory?.title ?? memory?.summary ?? memory?.text ?? ''
    return daMemoria ? shortLabel(daMemoria) : memoryId
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
      {texto}
    </Text>
  )
})
