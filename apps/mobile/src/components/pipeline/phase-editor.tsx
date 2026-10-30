/**
 * Phase editor — full parity with the desktop PhaseEditor: name, description,
 * role, prompt and capabilities; "save as default" writes the master template
 * (only for phases with a templateId — a custom phase has no master).
 *
 * Mounted conditionally by the parent (with a key per phase): the initial state
 * comes straight from the props, without a reset effect. Bottom sheet (native
 * Modal), immune to the Dialog's positioning issues.
 */
import { useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { AllowedTool, PhaseChoice, PhaseKind } from '@orbit/shared'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const PHASE_KINDS: PhaseKind[] = ['development', 'validation', 'security', 'review', 'infra', 'generic']
const ALLOWED_TOOLS: AllowedTool[] = ['read', 'edit', 'shell', 'browser', 'memory']

export function PhaseEditor({
  onClose,
  phase,
  onSave,
}: {
  onClose: () => void
  /** Phase being edited — null = new phase (from scratch). */
  phase: PhaseChoice | null
  onSave: (phase: PhaseChoice, saveAsDefault: boolean) => void | Promise<void>
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  // Initial state from the props: the parent mounts it with a key per phase, so
  // switching phase (or opening it for a new one) remounts and clears everything.
  const [name, setName] = useState(phase?.name ?? '')
  const [description, setDescription] = useState(phase?.description ?? '')
  const [kind, setKind] = useState<PhaseKind>(phase?.kind ?? 'generic')
  const [prompt, setPrompt] = useState(phase?.prompt ?? '')
  const [tools, setTools] = useState<AllowedTool[]>(phase ? [...phase.tools] : ['read'])
  const [saving, setSaving] = useState(false)

  const canSaveAsDefault = !!phase?.templateId
  const valid = name.trim().length > 0 && prompt.trim().length > 0

  const toggleTool = (tool: AllowedTool) => {
    setTools((current) => (current.includes(tool) ? current.filter((x) => x !== tool) : [...current, tool]))
  }

  const save = async (saveAsDefault: boolean) => {
    if (!valid || saving) return
    setSaving(true)
    try {
      await onSave(
        { templateId: phase?.templateId, name: name.trim(), description: description.trim(), prompt: prompt.trim(), tools, kind },
        saveAsDefault,
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <BottomSheet
      open
      onClose={onClose}
      // Editor with unsaved content: close only through the buttons, never by
      // tapping the backdrop nor with the Android back button.
      closeOnOutsideTap={false}
      maxHeight="92%"
      title={
        <Text style={[s.title, { color: tokens.foreground }]}>
          {phase ? t('pipeline.editPhase') : t('pipeline.newPhase')}
        </Text>
      }
    >
      <ScrollView style={{ maxHeight: 520 }} keyboardShouldPersistTaps="handled">
        <View style={s.field}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.phaseName')}</Text>
          <Input value={name} onChangeText={setName} placeholder={t('pipeline.phaseName')} />
        </View>

        <View style={s.field}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.phaseDescription')}</Text>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.phaseDescriptionHint')}</Text>
          <Input value={description} onChangeText={setDescription} placeholder={t('pipeline.phaseDescriptionHint')} />
        </View>

        <View style={s.field}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.phaseKind')}</Text>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.phaseKindHint')}</Text>
          <Select
            value={{ value: kind, label: t(`pipeline.kind.${kind}`) }}
            onValueChange={(opt) => opt && setKind(opt.value as PhaseKind)}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('pipeline.phaseKind')} />
            </SelectTrigger>
            <SelectContent>
              {PHASE_KINDS.map((option) => (
                <SelectItem key={option} label={t(`pipeline.kind.${option}`)} value={option} />
              ))}
            </SelectContent>
          </Select>
        </View>

        <View style={s.field}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.phasePrompt')}</Text>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.phasePromptHint')}</Text>
          <Textarea
            value={prompt}
            onChangeText={setPrompt}
            placeholder={t('pipeline.phasePromptHint')}
            style={{ minHeight: 180, maxHeight: 300, fontFamily: 'monospace' }}
          />
        </View>

        <View style={s.field}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.phaseCapabilities')}</Text>
          <View style={s.chips}>
            {ALLOWED_TOOLS.map((tool) => {
              const active = tools.includes(tool)
              return (
                <Pressable
                  key={tool}
                  onPress={() => toggleTool(tool)}
                  style={[
                    s.chip,
                    {
                      backgroundColor: active ? tokens.primary : tokens.muted,
                      borderColor: active ? tokens.primary : tokens.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      s.chipText,
                      { color: active ? tokens.primaryForeground : tokens.mutedForeground },
                    ]}
                  >
                    {t(`pipeline.capability.${tool}`)}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>
      </ScrollView>

      <View style={s.footer}>
        <Pressable onPress={onClose} style={s.secondaryButton}>
          <Text style={[s.secondaryButtonText, { color: tokens.foreground }]}>{t('sidebar.cancel')}</Text>
        </Pressable>
        {canSaveAsDefault && (
          <Pressable
            onPress={() => void save(true)}
            disabled={!valid || saving}
            style={[s.secondaryButton, { borderColor: tokens.border }]}
          >
            <Text style={[s.secondaryButtonText, { color: tokens.foreground }]}>
              {t('pipeline.saveAsDefault')}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => void save(false)}
          disabled={!valid || saving}
          style={[s.primaryButton, { backgroundColor: tokens.primary, opacity: valid && !saving ? 1 : 0.4 }]}
        >
          <Text style={[s.primaryButtonText, { color: tokens.primaryForeground }]}>
            {t('pipeline.saveInThisPipeline')}
          </Text>
        </Pressable>
      </View>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600', marginBottom: 10 },
  field: { gap: 5, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: '600' },
  hint: { fontSize: 11, lineHeight: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontSize: 11, fontWeight: '500' },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  secondaryButton: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  secondaryButtonText: { fontSize: 13, fontWeight: '500' },
  primaryButton: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  primaryButtonText: { fontSize: 13, fontWeight: '600' },
})
