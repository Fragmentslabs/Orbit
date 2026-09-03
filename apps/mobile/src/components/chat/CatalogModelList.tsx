import { memo, useCallback, useMemo } from 'react'
import type { ReactElement } from 'react'
import { SectionList, View, Text, Pressable, StyleSheet } from 'react-native'
import { Check } from 'lucide-react-native'
import type { CatalogModel, CatalogProvider } from '@orbit/shared'
import { useSettingsStore } from '~/stores/settings-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'
import { ModalityIcons } from '~/components/ui/modality-icons'
import { ProviderLogo } from '~/components/ui/provider-logo'

/**
 * Lista de modelos do catálogo, por provedor — virtualizada.
 *
 * Os modais de worker e de visão montavam o catálogo inteiro dentro de um
 * ScrollView (`groups.map(...)` aninhado): com os provedores conectados isso
 * são centenas de linhas construídas de uma vez só na abertura, e reconstruídas
 * inteiras a cada toque (o estado muda → tudo re-renderiza). Daí a demora para
 * abrir e para selecionar.
 *
 * Aqui a SectionList monta só o que cabe na tela, a linha é memoizada (escolher
 * um modelo re-renderiza duas linhas, não a lista) e sem busca cada provedor
 * mostra no máximo MAX_POR_PROVEDOR — o mesmo teto do picker de modelos.
 */

/** Teto por provedor ao navegar sem busca (igual ao ModelPickerModal e ao
 *  desktop). Com busca o teto não vale: esconder resultado é pior. */
const MAX_POR_PROVEDOR = 40

const CARD_RADIUS = 12

interface Secao {
  provider: CatalogProvider
  data: { key: string; model: CatalogModel }[]
}

interface CatalogModelListProps {
  /** Texto da busca (o input vive no cabeçalho, que é do dono da lista). */
  search: string
  /** Filtro extra por modelo — ex.: só modelos com visão. */
  includeModel?: (provider: CatalogProvider, model: CatalogModel) => boolean
  selected: { providerId: string; modelId: string } | null
  onSelect: (providerId: string, modelId: string) => void
  /** Cabeçalho rolável (título, busca, cards de config). Passe um ELEMENTO,
   *  não um componente: componente inline remonta a cada tecla digitada. */
  header?: ReactElement
  emptyLabel: string
}

export function CatalogModelList({
  search,
  includeModel,
  selected,
  onSelect,
  header,
  emptyLabel,
}: CatalogModelListProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const catalog = useSettingsStore((s) => s.catalog)
  const connectedProviders = useSettingsStore((s) => s.connectedProviders)

  const sections = useMemo<Secao[]>(() => {
    if (!catalog) return []
    const q = search.toLowerCase().trim()
    return Object.values(catalog)
      .filter((provider) => connectedProviders.includes(provider.id))
      .map((provider) => {
        const models = Object.values(provider.models)
          .filter(
            (model) =>
              (!includeModel || includeModel(provider, model)) &&
              (!q ||
                model.name.toLowerCase().includes(q) ||
                model.id.toLowerCase().includes(q)),
          )
          .sort((a, b) =>
            a.release_date && b.release_date
              ? b.release_date.localeCompare(a.release_date)
              : a.name.localeCompare(b.name),
          )
        const visiveis = q ? models : models.slice(0, MAX_POR_PROVEDOR)
        return {
          provider,
          data: visiveis.map((model) => ({ key: `${provider.id}/${model.id}`, model })),
        }
      })
      .filter((secao) => secao.data.length > 0)
  }, [catalog, connectedProviders, search, includeModel])

  const renderItem = useCallback(
    ({ item, index, section }: { item: { model: CatalogModel }; index: number; section: Secao }) => (
      <ModelRow
        provider={section.provider}
        model={item.model}
        index={index}
        count={section.data.length}
        isSelected={
          selected?.providerId === section.provider.id && selected?.modelId === item.model.id
        }
        tokens={tokens}
        onPress={onSelect}
      />
    ),
    [selected?.providerId, selected?.modelId, tokens, onSelect],
  )

  return (
    <SectionList
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: 24 }}
      sections={sections}
      keyExtractor={(item) => item.key}
      renderItem={renderItem}
      renderSectionHeader={({ section }) => (
        <Text style={[s.providerLabel, { color: tokens.mutedForeground }]}>
          {(section as Secao).provider.name}
        </Text>
      )}
      SectionSeparatorComponent={() => <View style={{ height: 12 }} />}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <Text style={[s.empty, { color: tokens.mutedForeground }]}>{emptyLabel}</Text>
      }
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={7}
      updateCellsBatchingPeriod={40}
      removeClippedSubviews
    />
  )
}

/** Linha memoizada: como a lista é virtualizada, cada linha desenha o próprio
 *  pedaço do card (borda + raio nas pontas) para o grupo continuar parecendo um
 *  card só. */
const ModelRow = memo(
  function ModelRow({
    provider,
    model,
    index,
    count,
    isSelected,
    tokens,
    onPress,
  }: {
    provider: CatalogProvider
    model: CatalogModel
    index: number
    count: number
    isSelected: boolean
    tokens: Record<string, string>
    onPress: (providerId: string, modelId: string) => void
  }) {
    const isFirst = index === 0
    const isLast = index === count - 1
    const selectedBg = hslToRgba(
      tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
      0.08,
    )
    return (
      <Pressable
        onPress={() => onPress(provider.id, model.id)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          backgroundColor: isSelected ? selectedBg : pressed ? tokens.muted : tokens.card,
          borderColor: tokens.border,
          borderTopWidth: isFirst ? 1 : 0,
          borderBottomWidth: 1,
          borderLeftWidth: 1,
          borderRightWidth: 1,
          borderTopLeftRadius: isFirst ? CARD_RADIUS : 0,
          borderTopRightRadius: isFirst ? CARD_RADIUS : 0,
          borderBottomLeftRadius: isLast ? CARD_RADIUS : 0,
          borderBottomRightRadius: isLast ? CARD_RADIUS : 0,
        })}
      >
        <ProviderLogo providerId={provider.id} size={16} color={tokens.mutedForeground} />
        <View style={{ flex: 1 }}>
          <Text style={[s.modelName, { color: tokens.foreground }]}>{model.name}</Text>
          <Text style={[s.modelId, { color: tokens.mutedForeground }]} numberOfLines={1}>
            {model.id}
          </Text>
        </View>
        <ModalityIcons modalities={model.modalities?.input} color={tokens.mutedForeground} />
        {isSelected && <Check size={16} color={tokens.primary} />}
      </Pressable>
    )
  },
  (prev, next) =>
    prev.model === next.model &&
    prev.provider === next.provider &&
    prev.index === next.index &&
    prev.count === next.count &&
    prev.isSelected === next.isSelected &&
    prev.tokens === next.tokens &&
    prev.onPress === next.onPress,
)

const s = StyleSheet.create({
  providerLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    paddingLeft: 4,
  },
  modelName: { fontSize: 14, fontWeight: '500' },
  modelId: { fontSize: 11 },
  empty: { fontSize: 13, textAlign: 'center', paddingVertical: 24 },
})
