import { useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert } from 'react-native'
import { X, Save } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useToolsStore } from '~/stores/tools-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { Skill } from '@orbit/shared'

interface SkillFormModalProps {
  visible: boolean
  onClose: () => void
  edit?: Skill
}

const SLUG_REGEX = /^[a-z][a-z0-9_]{0,59}$/

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60)
}

export function SkillFormModal({ visible, onClose, edit }: SkillFormModalProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const createSkill = useToolsStore((s) => s.createSkill)
  const [name, setName] = useState(edit?.name ?? '')
  const [slug, setSlug] = useState(edit?.slug ?? '')
  const [description, setDescription] = useState(edit?.description ?? '')
  const [content, setContent] = useState(edit?.content ?? '')
  const [saving, setSaving] = useState(false)
  const [slugEdited, setSlugEdited] = useState(!!edit)

  const handleNameChange = (text: string) => {
    setName(text)
    if (!slugEdited) setSlug(slugify(text))
  }

  const handleSave = async () => {
    if (!name.trim()) return Alert.alert(t('skillFormModal.nameRequiredTitle'), t('skillFormModal.nameRequiredBody'))
    if (!content.trim()) return Alert.alert(t('skillFormModal.contentRequiredTitle'), t('skillFormModal.contentRequiredBody'))
    if (slug && !SLUG_REGEX.test(slug)) return Alert.alert(t('skillFormModal.invalidSlugTitle'), t('skillFormModal.invalidSlugBody'))
    setSaving(true)
    try {
      await createSkill({
        name: name.trim(),
        description: description.trim(),
        content: content.trim(),
        slug: slug || undefined,
      })
      onClose()
    } catch {
      Alert.alert(t('skillFormModal.errorTitle'), t('skillFormModal.errorBody'))
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    setName(edit?.name ?? '')
    setSlug(edit?.slug ?? '')
    setDescription(edit?.description ?? '')
    setContent(edit?.content ?? '')
    setSlugEdited(!!edit)
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <View style={s.backdropWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        <View style={[s.sheet, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />
          <View style={s.header}>
            <Text style={[s.headerTitle, { color: tokens.foreground }]}>
              {edit ? t('skillFormModal.editTitle') : t('skillFormModal.newTitle')}
            </Text>
            <Pressable onPress={handleClose} style={s.closeBtn}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
            <View>
              <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('skillFormModal.nameLabel')}</Text>
              <TextInput
                value={name}
                onChangeText={handleNameChange}
                placeholder={t('skillFormModal.namePlaceholder')}
                placeholderTextColor={tokens.mutedForeground}
                style={[s.input, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
              />
            </View>

            <View>
              <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('skillFormModal.slugLabel')}</Text>
              <TextInput
                value={slug}
                onChangeText={(v) => { setSlug(v); setSlugEdited(true) }}
                placeholder={t('skillFormModal.slugPlaceholder')}
                placeholderTextColor={tokens.mutedForeground}
                autoCapitalize="none"
                style={[s.input, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
              />
            </View>

            <View>
              <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('skillFormModal.descriptionLabel')}</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder={t('skillFormModal.descriptionPlaceholder')}
                placeholderTextColor={tokens.mutedForeground}
                style={[s.input, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
              />
            </View>

            <View>
              <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('skillFormModal.contentLabel')}</Text>
              <TextInput
                value={content}
                onChangeText={setContent}
                placeholder={t('skillFormModal.contentPlaceholder')}
                placeholderTextColor={tokens.mutedForeground}
                multiline
                textAlignVertical="top"
                style={[s.textarea, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
              />
            </View>
          </ScrollView>

          <View style={[s.footer, { borderTopColor: tokens.border }]}>
            <Pressable onPress={handleClose} style={[s.cancelBtn, { borderColor: tokens.border }]}>
              <Text style={[s.cancelText, { color: tokens.foreground }]}>{t('skillFormModal.cancel')}</Text>
            </Pressable>
            <Pressable onPress={handleSave} disabled={saving} style={[s.saveBtn, { backgroundColor: tokens.primary, opacity: saving ? 0.6 : 1 }]}>
              <Save size={16} color="#fff" />
              <Text style={s.saveText}>{saving ? t('skillFormModal.saving') : t('skillFormModal.save')}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    height: '85%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  closeBtn: { padding: 4, borderRadius: 8 },
  label: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  textarea: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 180,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 12,
    paddingBottom: 20,
    borderTopWidth: 1,
  },
  cancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelText: { fontSize: 14, fontWeight: '600' },
  saveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 10,
    paddingVertical: 12,
  },
  saveText: { fontSize: 14, fontWeight: '600', color: '#fff' },
})
