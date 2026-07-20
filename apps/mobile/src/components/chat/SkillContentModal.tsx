import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { X } from 'lucide-react-native'
import { AssistantMarkdown } from './AssistantMarkdown'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { Skill } from '@orbit/shared'

interface SkillContentModalProps {
  visible: boolean
  onClose: () => void
  skill: Skill | null
}

export function SkillContentModal({ visible, onClose, skill }: SkillContentModalProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  if (!skill) return null

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdropWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[s.sheet, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />
          <View style={s.header}>
            <View style={{ flex: 1 }}>
              <Text style={[s.skillName, { color: tokens.foreground }]}>{skill.name}</Text>
              <Text style={[s.skillSlug, { color: tokens.mutedForeground }]}>@{skill.slug}</Text>
            </View>
            <Pressable onPress={onClose} style={s.closeBtn}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>
          {skill.description ? (
            <Text style={[s.description, { color: tokens.mutedForeground }]}>{skill.description}</Text>
          ) : null}
          <View style={[s.divider, { backgroundColor: tokens.border }]} />
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            <AssistantMarkdown text={skill.content} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    height: '80%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 4 },
  skillName: { fontSize: 16, fontWeight: '600' },
  skillSlug: { fontSize: 12, fontFamily: 'monospace', marginTop: 2 },
  closeBtn: { padding: 4, borderRadius: 8 },
  description: { fontSize: 13, lineHeight: 18, marginBottom: 8 },
  divider: { height: 1, marginVertical: 12 },
})
