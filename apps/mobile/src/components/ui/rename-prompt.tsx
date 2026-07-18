import { useEffect, useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, StyleSheet } from 'react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface RenamePromptProps {
  visible: boolean
  title: string
  initialValue: string
  onClose: () => void
  onSubmit: (value: string) => void
}

/** Modal simples de renomear (conversa ou pasta) — reutilizado no header do chat e na sidebar. */
export function RenamePrompt({ visible, title, initialValue, onClose, onSubmit }: RenamePromptProps) {
  const [value, setValue] = useState(initialValue)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  useEffect(() => {
    if (visible) setValue(initialValue)
  }, [visible, initialValue])

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed) onSubmit(trimmed)
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={[s.box, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <Text style={[s.title, { color: tokens.foreground }]}>{title}</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            autoFocus
            style={[s.input, { borderColor: tokens.border, color: tokens.foreground }]}
            placeholderTextColor={tokens.mutedForeground}
            onSubmitEditing={submit}
          />
          <View style={s.actions}>
            <Pressable onPress={onClose} style={s.cancelBtn}>
              <Text style={[s.cancelText, { color: tokens.mutedForeground }]}>Cancelar</Text>
            </Pressable>
            <Pressable onPress={submit} style={[s.saveBtn, { backgroundColor: tokens.primary }]}>
              <Text style={[s.saveText, { color: tokens.primaryForeground }]}>Salvar</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: 32 },
  box: { width: '100%', maxWidth: 340, borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  title: { fontSize: 16, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  cancelBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  cancelText: { fontSize: 14 },
  saveBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  saveText: { fontSize: 14, fontWeight: '600' },
})
