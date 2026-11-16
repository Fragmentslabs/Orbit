import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { ComponentType } from 'react'
import { MessageSquare, Pencil, X } from 'lucide-react-native'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import type { CreationKind } from '~/hooks/useCreationChat'
import { useTokens } from './parts'

/**
 * The "New" menu of a list: describing it in a chat first (recommended), the form second, and a few
 * examples that open the chat already filled. The same shape for every kind, texts under `creation.<kind>`.
 */
export function CreateSheet({
  kind,
  open,
  onClose,
  onChat,
  onForm,
  extra,
}: {
  kind: CreationKind
  open: boolean
  onClose: () => void
  /** Opens the creation chat; `text` is an example's sentence (absent = the starter). */
  onChat: (text?: string) => void
  onForm: () => void
  /** More ways to create after the form (e.g. importing a file for a skill). */
  extra?: { key: string; icon: ComponentType<{ size?: number; color?: string }>; title: string; hint: string; onPress: () => void }[]
}) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const examples = [1, 2, 3].map((n) => ({
    label: t(`creation.${kind}.example${n}Label`),
    text: t(`creation.${kind}.example${n}Text`),
  }))
  const close = (then: () => void) => () => {
    onClose()
    then()
  }

  return (
    <BottomSheet open={open} onClose={onClose}>
      <View style={s.body}>
        <View style={s.head}>
          <Text style={[s.title, { color: tokens.foreground }]}>{t(`creation.${kind}.sheetTitle`)}</Text>
          <Pressable onPress={onClose} style={s.close} accessibilityLabel={t('creation.close')}>
            <X size={20} color={tokens.foreground} />
          </Pressable>
        </View>

        <Pressable
          onPress={close(() => onChat())}
          style={[s.option, { borderColor: tokens.primary, backgroundColor: `${tokens.primary.replace('hsl(', 'hsla(').replace(')', ', 0.12)')}` }]}
        >
          <View style={[s.tile, { backgroundColor: tokens.primary }]}>
            <MessageSquare size={19} color={tokens.primaryForeground} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.optionTitle, { color: tokens.foreground }]}>
              {t(`creation.${kind}.chatTitle`)}{'  '}
              <Text style={[s.tag, { backgroundColor: tokens.primary, color: tokens.primaryForeground }]}> {t('creation.recommended')} </Text>
            </Text>
            <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t(`creation.${kind}.chatHint`)}</Text>
          </View>
        </Pressable>

        <Pressable onPress={close(onForm)} style={[s.option, { borderColor: tokens.border }]}>
          <View style={[s.tile, { backgroundColor: tokens.muted }]}>
            <Pencil size={18} color={tokens.mutedForeground} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.optionTitle, { color: tokens.foreground }]}>{t(`creation.${kind}.formTitle`)}</Text>
            <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t(`creation.${kind}.formHint`)}</Text>
          </View>
        </Pressable>

        {extra?.map((option) => (
          <Pressable key={option.key} onPress={close(option.onPress)} style={[s.option, { borderColor: tokens.border }]}>
            <View style={[s.tile, { backgroundColor: tokens.muted }]}>
              <option.icon size={18} color={tokens.mutedForeground} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.optionTitle, { color: tokens.foreground }]}>{option.title}</Text>
              <Text style={[s.hint, { color: tokens.mutedForeground }]}>{option.hint}</Text>
            </View>
          </Pressable>
        ))}

        <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('creation.examples').toUpperCase()}</Text>
        <View style={s.chips}>
          {examples.map((example) => (
            <Pressable
              key={example.label}
              onPress={close(() => onChat(example.text))}
              style={[s.chip, { borderColor: tokens.border }]}
            >
              <Text style={{ fontSize: 13.5, color: tokens.mutedForeground }}>{example.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  // The sheet already gives the side margin and the bottom space; adding them here doubled the padding.
  body: { gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 17, fontWeight: '600' },
  // 44px touch target, with the glyph pulled out to the content's right edge.
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -10 },
  option: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderRadius: 16, borderWidth: 1 },
  tile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  optionTitle: { fontSize: 15, fontWeight: '600' },
  tag: { fontSize: 10.5, fontWeight: '600' },
  hint: { marginTop: 3, fontSize: 12.5, lineHeight: 18 },
  label: { marginTop: 6, fontSize: 11, letterSpacing: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 13, borderRadius: 99, borderWidth: 1 },
})
