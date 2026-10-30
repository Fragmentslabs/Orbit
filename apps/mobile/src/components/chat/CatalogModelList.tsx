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
 * Model list of the catalog, per provider — virtualized.
 *
 * The worker and vision modals built the whole catalog inside a
 * ScrollView (nested `groups.map(...)`): with the connected providers that is
 * hundreds of rows built at once on opening, and rebuilt
 * whole on every touch (the state changes → everything re-renders). Hence the slowness to
 * open and to select.
 *
 * Here the SectionList mounts only what fits on screen, the row is memoized (choosing
 * a model re-renders two rows, not the list) and without a search each provider
 * shows at most MAX_PER_PROVIDER — the same ceiling as the model picker.
 */

/** Ceiling per provider when browsing without a search (same as ModelPickerModal and the
 *  desktop). With a search the ceiling does not apply: hiding a result is worse. */
const MAX_PER_PROVIDER = 40

const CARD_RADIUS = 12

interface ModelSection {
  provider: CatalogProvider
  data: { key: string; model: CatalogModel }[]
}

interface CatalogModelListProps {
  /** Search text (the input lives in the header, which belongs to the owner of the list). */
  search: string
  /** Extra filter by model — e.g. only models with vision. */
  includeModel?: (provider: CatalogProvider, model: CatalogModel) => boolean
  selected: { providerId: string; modelId: string } | null
  onSelect: (providerId: string, modelId: string) => void
  /** Scrollable header (title, search, config cards). Pass an ELEMENT,
   *  not a component: an inline component remounts on every keystroke. */
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

  const sections = useMemo<ModelSection[]>(() => {
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
        const visible = q ? models : models.slice(0, MAX_PER_PROVIDER)
        return {
          provider,
          data: visible.map((model) => ({ key: `${provider.id}/${model.id}`, model })),
        }
      })
      .filter((group) => group.data.length > 0)
  }, [catalog, connectedProviders, search, includeModel])

  const renderItem = useCallback(
    ({ item, index, section }: { item: { model: CatalogModel }; index: number; section: ModelSection }) => (
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
          {(section as ModelSection).provider.name}
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

/** Memoized row: since the list is virtualized, each row draws its own
 *  piece of the card (border + radius at the ends) so the group keeps looking like a
 *  single card. */
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
