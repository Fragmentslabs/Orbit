import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, SectionList, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X, Search, Check, Brain, RefreshCw, ListRestart, ChevronRight } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useRouter } from 'expo-router'
import type { CatalogModel, CatalogProvider, ModelRotation } from '@orbit/shared'
import { useSettingsStore } from '~/stores/settings-store'
import { useSessionModel } from '~/stores/session-store'
import { useSessionModelPrefs, type SelectedModel } from '~/stores/session-model-prefs'
import { useModelRotationStore, useSessionRotation } from '~/stores/model-rotation-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { hslToRgba } from '~/lib/theme'
import { Spin } from '~/components/ui/spin'
import { ModalityIcons } from '~/components/ui/modality-icons'
import { ProviderLogo } from '~/components/ui/provider-logo'
import { cn } from '~/lib/utils'

interface ModelPickerModalProps {
  visible: boolean
  onClose: () => void
  /** Session that owns the choice — undefined/null = new chat (draft). */
  sessionId?: string | null
  /** Displayed selection (per-session model override) — used by the routines,
   *  which keep their own model. undefined = follows the sessionId. */
  selected?: { providerId: string; modelId: string } | null
  /** Selection callback — when present, it replaces the per-session selectModel
   *  (the owner of the choice decides what to do with it). */
  onSelect?: (providerId: string, modelId: string) => void
}

/** Limit of models per provider when browsing (no search) — mirrors the desktop
 *  (MAX_MODELS_PER_PROVIDER in model-picker.tsx). With an active search the limit is
 *  ignored so as not to hide searchable models. */
const MAX_MODELS_PER_PROVIDER = 40

/** Radius of the card that groups the models (rounded-xl). */
const CARD_RADIUS = 12

function ModelRowSkeleton({ tokens }: { tokens: Record<string, string> }) {
  return (
    <View className="flex-row items-center gap-3 px-4 py-3.5">
      <View className="h-4 w-4 rounded-full" style={{ backgroundColor: tokens.muted }} />
      <View className="flex-1 gap-1.5">
        <View className="h-3 w-32 rounded" style={{ backgroundColor: tokens.muted }} />
        <View className="h-2.5 w-20 rounded" style={{ backgroundColor: tokens.muted }} />
      </View>
    </View>
  )
}

interface ModelRowItem {
  key: string
  model: CatalogModel
}

interface RecentRowItem {
  key: string
  model: CatalogModel
  provider: CatalogProvider
  recent: SelectedModel
}

interface RotationRowItem {
  key: string
  rotation: ModelRotation
}

/** Model in use, pinned at the top when it is not among the recents. */
interface SelectedRowItem {
  key: string
  model: CatalogModel
  provider: CatalogProvider
  selected: SelectedModel
}

/** Item of any of the sections — annotated explicitly in the SectionList,
 *  which otherwise infers the type of the first member of the union and rejects the others. */
type ModelSectionItem = RotationRowItem | SelectedRowItem | RecentRowItem | ModelRowItem

type ModelSection =
  | { kind: 'rotations'; data: RotationRowItem[] }
  | { kind: 'selected'; data: SelectedRowItem[] }
  | { kind: 'recents'; data: RecentRowItem[] }
  | { kind: 'provider'; provider: CatalogProvider; data: ModelRowItem[] }

/**
 * Model row. Since the SectionList virtualizes the rows, each row draws
 * its own piece of the card (borders + radius at the ends) so the group keeps
 * visually a single card — equivalent to the original card with overflow-hidden.
 */
const ModelRow = memo(function ModelRow({
  provider,
  model,
  index,
  count,
  isSelected,
  tokens,
  onPress,
  subtitle,
  onRemove,
}: {
  provider: CatalogProvider
  model: CatalogModel
  index: number
  count: number
  isSelected: boolean
  tokens: Record<string, string>
  onPress: (providerId: string, modelId: string) => void
  /** Text below the name (default: model id; recents: provider name) */
  subtitle?: string
  /** "x" button to remove (recents) — does not trigger the selection of the row */
  onRemove?: () => void
}) {
  const isFirst = index === 0
  const isLast = index === count - 1
  const rowSelectedBg = hslToRgba(
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
        paddingVertical: 11,
        backgroundColor: isSelected
          ? rowSelectedBg
          : pressed
            ? tokens.muted
            : tokens.card,
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
      {/* Provider Logo */}
      <ProviderLogo providerId={provider.id} size={16} color={tokens.mutedForeground} />

      {/* Model Info */}
      <View className="flex-1">
        <Text className="text-sm font-medium" style={{ color: tokens.foreground }}>{model.name}</Text>
        <Text className="text-xs" style={{ color: tokens.mutedForeground }} numberOfLines={1}>
          {subtitle ?? model.id}
        </Text>
      </View>

      {/* Indicators */}
      <ModalityIcons modalities={model.modalities?.input} color={tokens.mutedForeground} />
      {model.reasoning && (
        <Brain size={14} color={tokens.mutedForeground} style={{ marginRight: 4 }} />
      )}

      {isSelected && <Check size={16} color={tokens.primary} />}

      {onRemove && (
        <Pressable
          onPress={onRemove}
          hitSlop={8}
          style={({ pressed }) => ({
            padding: 4,
            borderRadius: 6,
            backgroundColor: pressed ? tokens.muted : 'transparent',
          })}
        >
          <X size={14} color={tokens.mutedForeground} />
        </Pressable>
      )}
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
  prev.subtitle === next.subtitle &&
  prev.onPress === next.onPress &&
  prev.onRemove === next.onRemove,
)

/**
 * Rotation row — same sliced-card drawing as ModelRow, with the rotation
 * icon in place of the provider logo and the model count in place of
 * the id. Choosing a rotation PINS it in the chat, like a model.
 */
function RotationRow({
  rotation,
  index,
  count,
  isSelected,
  tokens,
  onPress,
}: {
  rotation: ModelRotation
  index: number
  count: number
  isSelected: boolean
  tokens: Record<string, string>
  onPress: (rotationId: string) => void
}) {
  const { t } = useTranslation()
  const isFirst = index === 0
  const isLast = index === count - 1
  const rowSelectedBg = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.08,
  )

  return (
    <Pressable
      onPress={() => onPress(rotation.id)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 11,
        backgroundColor: isSelected ? rowSelectedBg : pressed ? tokens.muted : tokens.card,
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
      <ListRestart size={16} color={tokens.mutedForeground} />
      <View className="flex-1">
        <Text className="text-sm font-medium" style={{ color: tokens.foreground }}>
          {rotation.name}
        </Text>
        <Text className="text-xs" style={{ color: tokens.mutedForeground }} numberOfLines={1}>
          {t('rotation.slotsLabel', { count: rotation.models.length })}
        </Text>
      </View>
      {isSelected && <Check size={16} color={tokens.primary} />}
    </Pressable>
  )
}

export function ModelPickerModal({ visible, ...props }: ModelPickerModalProps) {
  // Closed, it mounts nothing: the component lives next to the input (and the routine/pipeline
  // forms), and before it mounted the Modal + recalculated the sections of the
  // catalog on every render of the owner, even off screen.
  if (!visible) return null
  return <ModelPickerSheet {...props} />
}

/** Body of the model picker — search, catalog and rotations. It is a page of the "+"
 *  sheet in the chat and the content of the drawer the routine/pipeline forms still use. */
export function ModelPickerContent({
  onClose,
  sessionId,
  selected: selectedOverride,
  onSelect,
  inline,
}: Omit<ModelPickerModalProps, 'visible'> & {
  /** Inside the "+" sheet: the sheet already pads the sides, so the body drops its own. */
  inline?: boolean
}) {
  const { t } = useTranslation()
  const catalog = useSettingsStore((s) => s.catalog)
  const sessionModel = useSessionModel(sessionId)
  // undefined = follows the session model (chat); null = nothing selected;
  // object = model of the owner of the choice (routine).
  const selectedModel = selectedOverride === undefined ? sessionModel : selectedOverride
  const selectModel = useSessionModelPrefs((s) => s.selectModel)
  const router = useRouter()
  // Rotations: only in the uncontrolled mode (the choice of a routine/pipeline is of
  // a model, not of a chain) — same criterion as `hideRotationOptions`
  // on the desktop, which also avoids a rotation inside the rotation editor.
  const rotations = useModelRotationStore((s) => s.rotations)
  const selectRotation = useModelRotationStore((s) => s.selectRotation)
  const activeRotation = useSessionRotation(onSelect ? null : sessionId)
  const recents = useSessionModelPrefs((s) => s.recents)
  const removeRecent = useSessionModelPrefs((s) => s.removeRecent)
  const connectedProviders = useSettingsStore((s) => s.connectedProviders)
  const loading = useSettingsStore((s) => s.loading)
  const fetchCatalog = useSettingsStore((s) => s.fetchCatalog)

  const resolved = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(resolved)
  const [search, setSearch] = useState('')

  const isWeb = Platform.OS === 'web'

  // Catalog missing (first use without a cache): opens the drawer right away with the
  // skeleton while the fetch runs underneath. Only on mount — the component
  // now only exists while it is open.
  useEffect(() => {
    if (!catalog && !loading) void fetchCatalog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sections = useMemo<ModelSection[]>(() => {
    if (!catalog) return []

    const q = search.toLowerCase().trim()
    const matches = (model: CatalogModel, provider: CatalogProvider) =>
      !q ||
      model.name.toLowerCase().includes(q) ||
      model.id.toLowerCase().includes(q) ||
      provider.name.toLowerCase().includes(q)

    // Recents: only models still in the catalog and from connected providers;
    // hidden in the controlled mode (routines) — the choice there belongs to the routine, not
    // to the chat (same criterion as the desktop).
    const recentRows: RecentRowItem[] = onSelect
      ? []
      : recents
          .map((recent) => ({
            recent,
            provider: catalog[recent.providerId],
            model: catalog[recent.providerId]?.models[recent.modelId],
          }))
          .filter(
            (e): e is { recent: SelectedModel; provider: CatalogProvider; model: CatalogModel } =>
              !!e.provider &&
              !!e.model &&
              connectedProviders.includes(e.recent.providerId) &&
              matches(e.model, e.provider),
          )
          .map((e) => ({
            key: `recent-${e.recent.providerId}/${e.recent.modelId}`,
            model: e.model,
            provider: e.provider,
            recent: e.recent,
          }))

    const providerSections: ModelSection[] = Object.values(catalog)
      .filter((provider) => connectedProviders.includes(provider.id))
      .map((provider) => {
        const models = Object.values(provider.models)
          .filter((model) => matches(model, provider))
          .sort((a, b) => {
            if (a.release_date && b.release_date) {
              return b.release_date.localeCompare(a.release_date)
            }
            return a.name.localeCompare(b.name)
          })

        const visibleModels = q ? models : models.slice(0, MAX_MODELS_PER_PROVIDER)

        return {
          kind: 'provider' as const,
          provider,
          data: visibleModels.map((model) => ({ key: `${provider.id}/${model.id}`, model })),
        }
      })
      .filter((section) => section.data.length > 0)

    // Rotations at the top (before the recents), as in the desktop selector.
    const rotationRows: RotationRowItem[] = onSelect
      ? []
      : rotations
          .filter((r) => !q || r.name.toLowerCase().includes(q))
          .map((r) => ({ key: `rotation-${r.id}`, rotation: r }))

    // The model in use gets a section of its own when it is not among the recents: the
    // recents list is short on the phone and the current model could sit far down in
    // its provider.
    const selectedProvider = selectedModel ? catalog[selectedModel.providerId] : undefined
    const selectedCatalogModel =
      selectedModel && selectedProvider ? selectedProvider.models[selectedModel.modelId] : undefined
    const isAmongRecents =
      !!selectedModel &&
      recentRows.some(
        (r) =>
          r.recent.providerId === selectedModel.providerId &&
          r.recent.modelId === selectedModel.modelId,
      )
    const selectedRows: SelectedRowItem[] =
      selectedModel &&
      selectedProvider &&
      selectedCatalogModel &&
      !isAmongRecents &&
      matches(selectedCatalogModel, selectedProvider)
        ? [
            {
              key: `selected-${selectedModel.providerId}/${selectedModel.modelId}`,
              model: selectedCatalogModel,
              provider: selectedProvider,
              selected: selectedModel,
            },
          ]
        : []

    return [
      ...(rotationRows.length > 0 ? [{ kind: 'rotations' as const, data: rotationRows }] : []),
      ...(selectedRows.length > 0 ? [{ kind: 'selected' as const, data: selectedRows }] : []),
      ...(recentRows.length > 0 ? [{ kind: 'recents' as const, data: recentRows }] : []),
      ...providerSections,
    ]
  }, [catalog, search, connectedProviders, recents, onSelect, rotations, selectedModel])

  // Stable identity: the row is memoized and receives this as a prop.
  const handleSelect = useCallback(
    (providerId: string, modelId: string) => {
      if (onSelect) {
        onSelect(providerId, modelId)
        onClose()
        return
      }
      // Choosing a model undoes the chat rotation (and vice versa) — the engine
      // resolves the rotation BEFORE the pinned model, so without this the model
      // chosen here would not apply.
      selectRotation(sessionId ?? null, null)
      // Per chat: an existing session gets an override; a new chat (no session) becomes
      // the draft + global default — mirror of the desktop.
      selectModel(sessionId ?? null, providerId, modelId)
      onClose()
    },
    [onSelect, onClose, selectModel, selectRotation, sessionId],
  )

  /** Clicking the rotation pins it in the chat; clicking the one already pinned undoes it. */
  const handleSelectRotation = useCallback(
    (rotationId: string) => {
      const isActive = activeRotation?.id === rotationId
      selectRotation(sessionId ?? null, isActive ? null : rotationId)
      onClose()
    },
    [activeRotation, selectRotation, sessionId, onClose],
  )

  const openRotations = useCallback(() => {
    onClose()
    router.push('/(main)/rotations')
  }, [onClose, router])

  return (
    <View className="flex-1">
      {/* Search */}
          <View className={cn('py-2 mt-1 flex-row items-center gap-2', !inline && 'px-4')}>
            {/* Same shape and height as the main input: a round pill of 44px. */}
            <View className="flex-1 flex-row items-center gap-2.5 px-4 h-11 rounded-full" style={{ backgroundColor: tokens.muted }}>
              <Search size={17} color={tokens.mutedForeground} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder={t('modelPickerModal.searchPlaceholder')}
                placeholderTextColor={tokens.mutedForeground}
                className="flex-1 text-base py-0"
                style={{ color: tokens.foreground }}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {search.length > 0 && (
                <Pressable onPress={() => setSearch('')} className="p-0.5">
                  <X size={14} color={tokens.mutedForeground} />
                </Pressable>
              )}
            </View>
            <Pressable
              onPress={() => void fetchCatalog()}
              disabled={loading}
              className="h-11 w-11 items-center justify-center rounded-full"
              style={{ backgroundColor: tokens.muted }}
            >
              <Spin active={loading}>
                <RefreshCw size={18} color={tokens.mutedForeground} />
              </Spin>
            </Pressable>
          </View>

          {/* Catalog List */}
          {sections.length === 0 && loading ? (
            <View className={cn('gap-1 mt-2', !inline && 'px-4')}>
              <ModelRowSkeleton tokens={tokens} />
              <ModelRowSkeleton tokens={tokens} />
              <ModelRowSkeleton tokens={tokens} />
              <ModelRowSkeleton tokens={tokens} />
            </View>
          ) : sections.length === 0 ? (
            <View className={cn('py-12 mt-2 items-center', !inline && 'px-4')}>
              <Text className="text-sm mb-1 text-center font-medium" style={{ color: tokens.mutedForeground }}>{t('modelPickerModal.noModelsAvailable')}</Text>
              <Text className={cn('text-xs text-center leading-relaxed', !inline && 'px-4')} style={{ color: tokens.mutedForeground, opacity: 0.75 }}>
                {connectedProviders.length === 0
                  ? t('modelPickerModal.configureProviderHint')
                  : t('modelPickerModal.trySearchHint')}
              </Text>
            </View>
          ) : (
            <SectionList<ModelSectionItem, ModelSection>
              className="flex-1"
              contentContainerStyle={{ paddingHorizontal: inline ? 0 : 16, paddingTop: 8, paddingBottom: 16 }}
              sections={sections}
              keyExtractor={(item) => item.key}
              renderItem={({ item, index, section }) => {
                if (section.kind === 'rotations') {
                  const row = item as RotationRowItem
                  return (
                    <RotationRow
                      rotation={row.rotation}
                      index={index}
                      count={section.data.length}
                      isSelected={activeRotation?.id === row.rotation.id}
                      tokens={tokens}
                      onPress={handleSelectRotation}
                    />
                  )
                }
                if (section.kind === 'selected') {
                  const row = item as SelectedRowItem
                  return (
                    <ModelRow
                      provider={row.provider}
                      model={row.model}
                      index={index}
                      count={section.data.length}
                      isSelected
                      tokens={tokens}
                      subtitle={row.provider.name}
                      onPress={handleSelect}
                    />
                  )
                }
                if (section.kind === 'recents') {
                  const row = item as RecentRowItem
                  return (
                    <ModelRow
                      provider={row.provider}
                      model={row.model}
                      index={index}
                      count={section.data.length}
                      isSelected={
                        selectedModel?.providerId === row.recent.providerId &&
                        selectedModel?.modelId === row.recent.modelId
                      }
                      tokens={tokens}
                      subtitle={row.provider.name}
                      onRemove={() => removeRecent(row.recent.providerId, row.recent.modelId)}
                      onPress={handleSelect}
                    />
                  )
                }
                const row = item as ModelRowItem
                return (
                  <ModelRow
                    provider={section.provider}
                    model={row.model}
                    index={index}
                    count={section.data.length}
                    isSelected={
                      selectedModel?.providerId === section.provider.id &&
                      selectedModel?.modelId === row.model.id
                    }
                    tokens={tokens}
                    onPress={handleSelect}
                  />
                )
              }}
              renderSectionHeader={({ section }) => (
                <Text className="text-xs font-semibold uppercase tracking-wider mb-2 pt-1 pl-1" style={{ color: tokens.mutedForeground }}>
                  {section.kind === 'rotations'
                    ? t('modelPicker.rotation')
                    : section.kind === 'selected'
                      ? t('modelPickerModal.selected')
                      : section.kind === 'recents'
                        ? t('modelPickerModal.recent')
                        : section.provider.name}
                </Text>
              )}
              SectionSeparatorComponent={() => <View className="h-4" />}
              stickySectionHeadersEnabled={false}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={isWeb}
              initialNumToRender={14}
              maxToRenderPerBatch={14}
              windowSize={7}
              updateCellsBatchingPeriod={40}
            />
          )}

          {/* Footer: manage rotations — mirror of the "Create rotation" button in the
              footer of the desktop selector. Hidden in the controlled mode
              (routine/pipeline/rotation slot), where the choice is of a model. */}
          {!onSelect && (
            <Pressable
              onPress={openRotations}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingHorizontal: inline ? 0 : 16,
                paddingVertical: 14,
                borderTopWidth: 1,
                borderTopColor: tokens.border,
                backgroundColor: pressed ? tokens.muted : 'transparent',
              })}
            >
              <ListRestart size={16} color={tokens.mutedForeground} />
              <Text className="flex-1 text-sm" style={{ color: tokens.foreground }}>
                {t('rotation.manage')}
              </Text>
              <ChevronRight size={16} color={tokens.mutedForeground} />
            </Pressable>
          )}
    </View>
  )
}

/** Drawer of the model picker — the chrome around ModelPickerContent, kept for the
 *  routine, pipeline and rotation forms, which are not inside the "+" sheet. */
function ModelPickerSheet({
  onClose,
  sessionId,
  selected,
  onSelect,
}: Omit<ModelPickerModalProps, 'visible'>) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const isWeb = Platform.OS === 'web'

  return (
    <Modal visible transparent animationType={isWeb ? 'fade' : 'slide'} onRequestClose={onClose}>
      <View
        className={cn('flex-1', isWeb ? 'justify-center items-center p-4' : 'justify-end')}
        style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      >
        <Pressable className="absolute inset-0" onPress={onClose} />

        <View
          className={cn(
            'shadow-2xl overflow-hidden',
            isWeb ? 'w-full max-w-md h-[550px] rounded-2xl' : 'w-full h-[80%] rounded-t-3xl',
          )}
          style={{
            backgroundColor: tokens.background,
            borderColor: tokens.border,
            borderWidth: isWeb ? 1 : 0,
            paddingBottom: isWeb ? 0 : insets.bottom,
          }}
        >
          {!isWeb && (
            <View className="items-center py-2">
              <View
                className="w-10 h-1.5 rounded-full"
                style={{
                  backgroundColor: hslToRgba(
                    tokens.mutedForeground.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
                    0.3,
                  ),
                }}
              />
            </View>
          )}

          <View
            className="flex-row items-center justify-between px-4 py-3.5"
            style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: tokens.foreground }}>
              {t('modelPickerModal.title')}
            </Text>
            <Pressable
              onPress={onClose}
              className="p-1 rounded-md"
              style={({ pressed }) => (pressed ? { backgroundColor: tokens.muted } : undefined)}
            >
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>

          <ModelPickerContent
            onClose={onClose}
            sessionId={sessionId}
            selected={selected}
            onSelect={onSelect}
          />
        </View>
      </View>
    </Modal>
  )
}
