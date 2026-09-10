import { useMemo, useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ArrowLeft, ChevronDown, ChevronUp, Plus, Trash2, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ModelPickerModal } from '~/components/chat/ModelPickerModal'
import { ProviderLogo } from '~/components/ui/provider-logo'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useModelRotationStore, MAX_ROTATION_SLOTS } from '~/stores/model-rotation-store'
import type { SelectedModel } from '~/stores/session-model-prefs'

/**
 * Editor de uma rotação (espelho do painel de detalhe do modal do desktop):
 * nome, slots 1..N com o modelo de cada um, e excluir no rodapé.
 *
 * Reordenar: no desktop é drag-and-drop; aqui são setas ↑/↓ por linha —
 * arrastar dentro de um ScrollView no celular briga com o scroll, e a lista
 * tem no máximo 4 itens.
 */
export default function RotationEditorScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const rotation = useModelRotationStore((s) => s.rotations.find((r) => r.id === id) ?? null)
  const rename = useModelRotationStore((s) => s.rename)
  const updateModels = useModelRotationStore((s) => s.updateModels)
  const remove = useModelRotationStore((s) => s.remove)
  const rotations = useModelRotationStore((s) => s.rotations)
  const catalog = useSettingsStore((s) => s.catalog)

  const [name, setName] = useState(rotation?.name ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  /** Índice do slot com o seletor de modelo aberto (null = fechado). */
  const [pickerSlot, setPickerSlot] = useState<number | null>(null)

  const models = useMemo(() => rotation?.models ?? [], [rotation])

  if (!rotation) {
    return (
      <SafeScreen>
        <View style={[s.header, { borderBottomColor: tokens.border }]}>
          <Pressable onPress={() => router.back()} style={s.backBtn}>
            <ArrowLeft size={22} color={tokens.foreground} />
          </Pressable>
          <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('rotation.title')}</Text>
          <View style={{ width: 34 }} />
        </View>
        <View style={s.empty}>
          <Text style={{ fontSize: 13, color: tokens.mutedForeground }}>{t('rotation.notFound')}</Text>
        </View>
      </SafeScreen>
    )
  }

  const commitName = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError(t('rotation.nameRequired'))
      setName(rotation.name)
      return
    }
    const duplicate = rotations.some(
      (r) => r.id !== rotation.id && r.name.trim().toLowerCase() === trimmed.toLowerCase(),
    )
    if (duplicate) {
      setNameError(t('rotation.nameDuplicate'))
      setName(rotation.name)
      return
    }
    setNameError(null)
    if (trimmed !== rotation.name) rename(rotation.id, trimmed)
  }

  const setSlot = (index: number, model: SelectedModel | null) => {
    const next = [...models]
    if (model) next[index] = model
    else next.splice(index, 1)
    updateModels(rotation.id, next)
  }

  const move = (from: number, to: number) => {
    if (to < 0 || to >= models.length) return
    const next = [...models]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    updateModels(rotation.id, next)
  }

  const addSlot = () => {
    if (models.length >= MAX_ROTATION_SLOTS) return
    // Slot vazio: o picker abre já apontando para ele.
    updateModels(rotation.id, [...models, { providerId: '', modelId: '' }])
    setPickerSlot(models.length)
  }

  const confirmRemove = () => {
    Alert.alert(
      t('rotation.confirmRemove', { name: rotation.name }),
      t('rotation.confirmRemoveDescription'),
      [
        { text: t('rotation.cancel'), style: 'cancel' },
        {
          text: t('rotation.remove'),
          style: 'destructive',
          onPress: () => {
            remove(rotation.id)
            router.back()
          },
        },
      ],
    )
  }

  const slotModel = pickerSlot === null ? null : models[pickerSlot] ?? null

  return (
    <SafeScreen>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text numberOfLines={1} style={[s.headerTitle, { color: tokens.foreground, flex: 1, textAlign: 'center' }]}>
          {rotation.name}
        </Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <TextInput
          value={name}
          onChangeText={(value) => {
            setName(value)
            if (nameError) setNameError(null)
          }}
          onBlur={commitName}
          onSubmitEditing={commitName}
          placeholder={t('rotation.namePlaceholder')}
          placeholderTextColor={tokens.mutedForeground}
          style={[
            s.nameInput,
            {
              borderColor: nameError ? tokens.destructive : tokens.border,
              color: tokens.foreground,
              backgroundColor: tokens.card,
            },
          ]}
        />
        {nameError ? (
          <Text style={{ fontSize: 11, color: tokens.destructive, marginTop: 6 }}>{nameError}</Text>
        ) : null}

        <View style={s.sectionRow}>
          <Text style={[s.sectionTitle, { color: tokens.mutedForeground }]}>
            {t('rotation.modelsSection')}
          </Text>
          <Text style={{ fontSize: 11, color: tokens.mutedForeground }}>
            {models.length}/{MAX_ROTATION_SLOTS}
          </Text>
        </View>

        <View style={{ gap: 8 }}>
          {models.map((model, index) => {
            const info =
              model.providerId && catalog
                ? catalog[model.providerId]?.models[model.modelId]
                : undefined
            const label = info?.name ?? model.modelId ?? ''
            return (
              <View
                key={`${rotation.id}-${index}`}
                style={[s.slot, { borderColor: tokens.border, backgroundColor: tokens.card }]}
              >
                <View style={s.reorder}>
                  <Pressable
                    onPress={() => move(index, index - 1)}
                    disabled={index === 0}
                    hitSlop={6}
                    style={{ opacity: index === 0 ? 0.25 : 1 }}
                  >
                    <ChevronUp size={16} color={tokens.mutedForeground} />
                  </Pressable>
                  <Pressable
                    onPress={() => move(index, index + 1)}
                    disabled={index === models.length - 1}
                    hitSlop={6}
                    style={{ opacity: index === models.length - 1 ? 0.25 : 1 }}
                  >
                    <ChevronDown size={16} color={tokens.mutedForeground} />
                  </Pressable>
                </View>

                <Text style={[s.slotIndex, { color: tokens.mutedForeground }]}>{index + 1}</Text>

                <Pressable onPress={() => setPickerSlot(index)} style={s.slotPicker}>
                  {model.providerId ? (
                    <ProviderLogo providerId={model.providerId} size={14} color={tokens.mutedForeground} />
                  ) : null}
                  <Text
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      fontSize: 13,
                      color: label ? tokens.foreground : tokens.mutedForeground,
                    }}
                  >
                    {label || t('rotation.slotNone')}
                  </Text>
                  <ChevronDown size={14} color={tokens.mutedForeground} />
                </Pressable>

                <Pressable onPress={() => setSlot(index, null)} hitSlop={6} style={{ padding: 2 }}>
                  <X size={16} color={tokens.mutedForeground} />
                </Pressable>
              </View>
            )
          })}

          {models.length < MAX_ROTATION_SLOTS && (
            <Pressable
              onPress={addSlot}
              style={({ pressed }) => [
                s.addSlot,
                { borderColor: tokens.border, backgroundColor: pressed ? tokens.muted : 'transparent' },
              ]}
            >
              <Plus size={16} color={tokens.mutedForeground} />
              <Text style={{ fontSize: 13, color: tokens.mutedForeground }}>{t('rotation.addModel')}</Text>
            </Pressable>
          )}
        </View>

        <Pressable
          onPress={confirmRemove}
          style={({ pressed }) => [
            s.deleteBtn,
            { borderTopColor: tokens.border, backgroundColor: pressed ? tokens.muted : 'transparent' },
          ]}
        >
          <Trash2 size={16} color={tokens.destructive} />
          <Text style={{ fontSize: 14, color: tokens.destructive }}>{t('rotation.removeRotation')}</Text>
        </Pressable>
      </ScrollView>

      {/* Seletor controlado: a escolha é do slot, não do chat — por isso
          `selected`/`onSelect` (o modo controlado também esconde recentes e
          as próprias rotações, evitando rotação dentro de rotação). */}
      {pickerSlot !== null && (
        <ModelPickerModal
          visible
          onClose={() => setPickerSlot(null)}
          selected={slotModel?.providerId ? slotModel : null}
          onSelect={(providerId, modelId) => {
            setSlot(pickerSlot, { providerId, modelId })
            setPickerSlot(null)
          }}
        />
      )}
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  backBtn: { padding: 6, borderRadius: 8 },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  nameInput: { height: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 14, fontWeight: '500' },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, marginBottom: 8 },
  sectionTitle: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  slot: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingLeft: 8, paddingRight: 8, height: 52 },
  reorder: { gap: 2 },
  slotIndex: { fontSize: 11, fontWeight: '600', width: 12, textAlign: 'center' },
  slotPicker: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  addSlot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed' },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 28, paddingTop: 16, borderTopWidth: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
})
