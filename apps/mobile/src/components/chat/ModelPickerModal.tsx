import { useEffect, useMemo, useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, SectionList, Platform } from 'react-native'
import { X, Search, Check, Brain, RefreshCw } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { CatalogModel, CatalogProvider } from '@orbit/shared'
import { useSettingsStore } from '~/stores/settings-store'
import { useSessionModel, useSessionModelPrefs, type SelectedModel } from '~/stores/session-model-prefs'
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
  /** Sessão dona da escolha — undefined/null = chat novo (draft). */
  sessionId?: string | null
  /** Seleção exibida (override do modelo por sessão) — usado pelas rotinas,
   *  que guardam o próprio modelo. undefined = segue o sessionId. */
  selected?: { providerId: string; modelId: string } | null
  /** Callback de seleção — quando presente, substitui o selectModel por
   *  sessão (o dono da escolha decide o que fazer com ela). */
  onSelect?: (providerId: string, modelId: string) => void
}

/** Limite de modelos por provedor ao navegar (sem busca) — espelha o desktop
 *  (MAX_MODELS_PER_PROVIDER em model-picker.tsx). Com busca ativa o limite é
 *  ignorado para não esconder modelos pesquisáveis. */
const MAX_MODELS_PER_PROVIDER = 40

/** Raio do card que agrupa os modelos (rounded-xl). */
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

type ModelSection =
  | { kind: 'recents'; data: RecentRowItem[] }
  | { kind: 'provider'; provider: CatalogProvider; data: ModelRowItem[] }

/**
 * Linha de modelo. Como a SectionList virtualiza as linhas, cada linha desenha
 * o próprio trecho do card (bordas + raio nas pontas) para o grupo continuar
 * visualmente um card único — equivalente ao card com overflow-hidden original.
 */
function ModelRow({
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
  /** Texto abaixo do nome (padrão: id do modelo; recentes: nome do provedor) */
  subtitle?: string
  /** Botão "x" de remover (recentes) — não dispara a seleção da linha */
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
}

export function ModelPickerModal({
  visible,
  onClose,
  sessionId,
  selected: selectedOverride,
  onSelect,
}: ModelPickerModalProps) {
  const { t } = useTranslation()
  const catalog = useSettingsStore((s) => s.catalog)
  const sessionModel = useSessionModel(sessionId)
  // undefined = segue o modelo da sessão (chat); null = nada selecionado;
  // objeto = modelo do dono da escolha (rotina).
  const selectedModel = selectedOverride === undefined ? sessionModel : selectedOverride
  const selectModel = useSessionModelPrefs((s) => s.selectModel)
  const recents = useSessionModelPrefs((s) => s.recents)
  const removeRecent = useSessionModelPrefs((s) => s.removeRecent)
  const connectedProviders = useSettingsStore((s) => s.connectedProviders)
  const loading = useSettingsStore((s) => s.loading)
  const fetchCatalog = useSettingsStore((s) => s.fetchCatalog)

  const resolved = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(resolved)
  const [search, setSearch] = useState('')

  const isWeb = Platform.OS === 'web'

  // Catálogo ausente (primeiro uso sem cache): abre o drawer na hora com o
  // skeleton enquanto o fetch roda por baixo.
  useEffect(() => {
    if (visible && !catalog && !loading) void fetchCatalog()
  }, [visible, catalog, loading, fetchCatalog])

  const sections = useMemo<ModelSection[]>(() => {
    if (!catalog) return []

    const q = search.toLowerCase().trim()
    const matches = (model: CatalogModel, provider: CatalogProvider) =>
      !q ||
      model.name.toLowerCase().includes(q) ||
      model.id.toLowerCase().includes(q) ||
      provider.name.toLowerCase().includes(q)

    // Recentes: só modelos ainda no catálogo e de provedores conectados;
    // ocultos no modo controlado (rotinas) — a escolha ali é da rotina, não
    // do chat (mesmo critério do desktop).
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

    return [
      ...(recentRows.length > 0 ? [{ kind: 'recents' as const, data: recentRows }] : []),
      ...providerSections,
    ]
  }, [catalog, search, connectedProviders, recents, onSelect])

  const handleSelect = async (providerId: string, modelId: string) => {
    if (onSelect) {
      onSelect(providerId, modelId)
      onClose()
      return
    }
    // Por chat: sessão existente ganha override; chat novo (sem sessão) vira
    // o draft + default global — espelho do desktop.
    selectModel(sessionId ?? null, providerId, modelId)
    onClose()
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={isWeb ? 'fade' : 'slide'}
      onRequestClose={onClose}
    >
      <View
        className={cn(
          "flex-1",
          isWeb ? "justify-center items-center p-4" : "justify-end"
        )}
        style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      >
        {/* Backdrop press to close */}
        <Pressable className="absolute inset-0" onPress={onClose} />

        {/* Modal/Drawer Container */}
        <View
          className={cn(
            "shadow-2xl overflow-hidden",
            isWeb
              ? "w-full max-w-md h-[550px] rounded-2xl"
              : "w-full h-[80%] rounded-t-3xl"
          )}
          style={{ backgroundColor: tokens.background, borderColor: tokens.border, borderWidth: isWeb ? 1 : 0 }}
        >
          {/* Mobile top handle indicator */}
          {!isWeb && (
            <View className="items-center py-2">
              <View className="w-10 h-1.5 rounded-full" style={{ backgroundColor: hslToRgba(tokens.mutedForeground.replace(/hsla?\(|\)/g, '').replace(/,/g, ''), 0.3) }} />
            </View>
          )}

          {/* Header */}
          <View className="flex-row items-center justify-between px-4 py-3.5" style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: tokens.foreground }}>{t('modelPickerModal.title')}</Text>
            <Pressable onPress={onClose} className="p-1 rounded-md" style={({ pressed }) => pressed ? { backgroundColor: tokens.muted } : undefined}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>

          {/* Search */}
          <View className="px-4 py-2 mt-1 flex-row items-center gap-2">
            <View className="flex-1 flex-row items-center gap-2 px-3 py-1.5 rounded-lg" style={{ backgroundColor: tokens.muted }}>
              <Search size={16} color={tokens.mutedForeground} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder={t('modelPickerModal.searchPlaceholder')}
                placeholderTextColor={tokens.mutedForeground}
                className="flex-1 text-sm py-0.5"
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
              className="h-9 w-9 items-center justify-center rounded-lg"
              style={{ backgroundColor: tokens.muted }}
            >
              <Spin active={loading}>
                <RefreshCw size={16} color={tokens.mutedForeground} />
              </Spin>
            </Pressable>
          </View>

          {/* Catalog List */}
          {sections.length === 0 && loading ? (
            <View className="gap-1 px-4 mt-2">
              <ModelRowSkeleton tokens={tokens} />
              <ModelRowSkeleton tokens={tokens} />
              <ModelRowSkeleton tokens={tokens} />
              <ModelRowSkeleton tokens={tokens} />
            </View>
          ) : sections.length === 0 ? (
            <View className="py-12 px-4 mt-2 items-center">
              <Text className="text-sm mb-1 text-center font-medium" style={{ color: tokens.mutedForeground }}>{t('modelPickerModal.noModelsAvailable')}</Text>
              <Text className="text-xs text-center px-4 leading-relaxed" style={{ color: tokens.mutedForeground, opacity: 0.75 }}>
                {connectedProviders.length === 0
                  ? t('modelPickerModal.configureProviderHint')
                  : t('modelPickerModal.trySearchHint')}
              </Text>
            </View>
          ) : (
            <SectionList
              className="flex-1"
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}
              sections={sections}
              keyExtractor={(item) => item.key}
              renderItem={({ item, index, section }) => {
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
                  {section.kind === 'recents' ? t('modelPickerModal.recent') : section.provider.name}
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
        </View>
      </View>
    </Modal>
  )
}
