/**
 * Folha da memória citada na conversa — o "hover card + aba do painel" do
 * desktop num só gesto, porque no celular não existe hover.
 *
 * Tocar no chip abre este resumo; o botão principal leva à tela de Memórias já
 * focada naquela memória (o parâmetro `id` seleciona o nó no grafo). Fechar
 * devolve a pessoa à conversa no mesmo ponto — nada de navegação perdida.
 *
 * É montada UMA vez no ChatScreen: os chips só pedem o id ao store, então uma
 * resposta com várias citações continua com uma folha só.
 */
import { useEffect, useMemo, useRef } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { Brain, ExternalLink } from 'lucide-react-native'
import { useMemoryStore } from '~/stores/memory-store'
import { useMemorySheetStore } from '~/stores/memory-sheet-store'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { kindLabel, categoryLabel, KIND_COLOR, formatDate } from './meta'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export function MemorySheet() {
  const { t } = useTranslation()
  const router = useRouter()
  const memoryId = useMemorySheetStore((s) => s.memoryId)
  const close = useMemorySheetStore((s) => s.close)
  const index = useMemoryStore((s) => s.index)
  const loading = useMemoryStore((s) => s.loading)
  const fetch = useMemoryStore((s) => s.fetch)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const memory = useMemo(
    () => (memoryId ? index.find((m) => m.id === memoryId) : undefined),
    [index, memoryId],
  )

  // Citação de uma memória que o índice local não tem (chegou depois, ou a
  // lista nunca foi buscada): pede uma vez por id. O ref evita o laço
  // fetch → índice igual → fetch de novo enquanto a memória não existir.
  const buscadoPara = useRef<string | null>(null)
  useEffect(() => {
    if (!memoryId || memory) return
    if (buscadoPara.current === memoryId) return
    buscadoPara.current = memoryId
    void fetch()
  }, [memoryId, memory, fetch])

  const abrirNaTela = () => {
    if (!memoryId) return
    close()
    router.push({ pathname: '/memories', params: { id: memoryId } })
  }

  const kindColor = memory ? KIND_COLOR[memory.kind] : tokens.mutedForeground

  return (
    <BottomSheet
      aberto={memoryId != null}
      aoFechar={close}
      titulo={
        <View style={s.titulo}>
          <Brain size={15} color={tokens.primary} />
          <Text style={[s.tituloTexto, { color: tokens.foreground }]}>{t('memorySheet.title')}</Text>
        </View>
      }
    >
      {memory ? (
        <View style={s.conteudo}>
          <Text style={[s.texto, { color: tokens.foreground }]}>{memory.text}</Text>

          <View style={s.badges}>
            <View style={[s.kindBadge, { backgroundColor: `${kindColor}26` }]}>
              <Text style={[s.kindBadgeText, { color: kindColor }]}>{kindLabel(memory.kind)}</Text>
            </View>
            {memory.kind === 'project' && memory.category && (
              <View style={[s.outlineBadge, { borderColor: tokens.muted }]}>
                <Text style={[s.outlineBadgeText, { color: tokens.mutedForeground }]}>
                  {categoryLabel(memory.category)}
                </Text>
              </View>
            )}
            {memory.projectName && (
              <View style={[s.outlineBadge, { borderColor: tokens.muted }]}>
                <Text style={[s.outlineBadgeText, { color: tokens.mutedForeground }]}>
                  {memory.projectName}
                </Text>
              </View>
            )}
            {memory.tags.slice(0, 4).map((tag) => (
              <Text key={tag} style={[s.tag, { color: tokens.mutedForeground }]}>#{tag}</Text>
            ))}
          </View>

          <Text style={[s.meta, { color: tokens.mutedForeground }]}>
            {t('memoryCard.uses', { count: memory.hits })} · {formatDate(memory.createdAt)}
          </Text>

          <View style={[s.acoes, { borderTopColor: tokens.border }]}>
            <Pressable onPress={close} style={s.secundario}>
              <Text style={[s.secundarioTexto, { color: tokens.mutedForeground }]}>
                {t('memorySheet.close')}
              </Text>
            </Pressable>
            <Pressable
              onPress={abrirNaTela}
              style={({ pressed }) => [
                s.primario,
                { backgroundColor: tokens.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <ExternalLink size={13} color={tokens.primaryForeground} />
              <Text style={[s.primarioTexto, { color: tokens.primaryForeground }]}>
                {t('memorySheet.openInScreen')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : loading ? (
        <View style={s.estado}>
          <ActivityIndicator color={tokens.primary} />
        </View>
      ) : (
        <View style={s.estado}>
          <Text style={[s.texto, { color: tokens.mutedForeground, textAlign: 'center' }]}>
            {t('memorySheet.notFound')}
          </Text>
          <Text style={[s.meta, { color: tokens.mutedForeground }]}>{memoryId}</Text>
        </View>
      )}
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  titulo: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  tituloTexto: { fontSize: 15, fontWeight: '600' },

  conteudo: { gap: 10 },
  texto: { fontSize: 14, lineHeight: 20 },

  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  kindBadge: { borderRadius: 9999, paddingHorizontal: 8, paddingVertical: 2 },
  kindBadgeText: { fontSize: 10, fontWeight: '600' },
  outlineBadge: { borderRadius: 9999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  outlineBadgeText: { fontSize: 10 },
  tag: { fontSize: 11 },
  meta: { fontSize: 11 },

  acoes: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    borderTopWidth: 1,
    paddingTop: 12,
    marginTop: 2,
  },
  secundario: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  secundarioTexto: { fontSize: 13, fontWeight: '500' },
  primario: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  primarioTexto: { fontSize: 13, fontWeight: '600' },

  estado: { alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 24 },
})
