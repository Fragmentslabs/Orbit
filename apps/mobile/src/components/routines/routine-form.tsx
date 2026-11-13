import { useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ArrowLeft, Folder, Sparkles } from 'lucide-react-native'
import type { Routine, RoutineModel, RoutineModes, RoutineSuggestion, Schedule } from '@orbit/shared'
import { DEFAULT_ROUTINE_PERMISSION, parseTime } from '@orbit/shared'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Skeleton } from '~/components/ui/skeleton'
import { FolderSelector } from '~/components/chat/FolderSelector'
import { useSettingsStore } from '~/stores/settings-store'
import { useRoutinesStore } from '~/stores/routines-store'
import { useSessionModel } from '~/stores/session-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'
import { ScheduleEditor, ModesEditor } from './schedule-editor'
import { RoutineModelPicker } from './routine-model-picker'

/**
 * Routines form — shared by creation and edition.
 *
 * Creation (without `routine`): two steps inside the same screen, like the
 * desktop modal —
 *   1. Describe — free text + model, and nothing else
 *   2. Review    — what the model proposed, all editable before confirming
 * Step 2 is never skipped: the agent SUGGESTS and the user decides.
 *
 * Edition (with `routine`): opens straight on the review with the fields filled
 * in.
 */
export function RoutineForm({
  routine,
  onDone,
}: {
  /** Present on edition; absent on creation. */
  routine?: Routine
  onDone: (routine: Routine) => void
}) {
  const { t, i18n } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const routines = useRoutinesStore((s) => s.routines)
  const generate = useRoutinesStore((s) => s.generate)
  const create = useRoutinesStore((s) => s.create)
  const update = useRoutinesStore((s) => s.update)
  // Vision model configured in the preferences: it is what the routine stores
  // when the Vision mode is on (the main process does not read localStorage).
  const visionModel = useSettingsStore((s) => s.visionModel)
  const visionAvailable = !!visionModel

  // Step 1 (creation)
  const [description, setDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<RoutineSuggestion | null>(null)

  // Default model of the creation: the last created routine's > the last chat's.
  // The previous routine comes first because it is the closest context to what
  // the user is doing now — whoever builds the second routine wants the same
  // model as the first.
  const last = [...routines].sort((a, b) => b.createdAt - a.createdAt)[0]
  const draftModel = useSessionModel(null)
  const [model, setModel] = useState<RoutineModel | null>(routine?.model ?? last?.model ?? draftModel)

  // Working folders are chosen IN STEP 1, together with the model — the generation
  // already uses those folders as prompt context. They are optional: without any,
  // the routine works only in its own folder.
  const [folders, setFolders] = useState<string[]>(routine?.folders ?? [])

  // Review fields (start from the suggestion/routine, but follow the edition)
  const [title, setTitle] = useState(routine?.title ?? '')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const [schedule, setSchedule] = useState<Schedule>(routine?.schedule ?? { time: '09:00' })
  const [modes, setModes] = useState<RoutineModes>(
    routine?.modes ?? { permissionMode: DEFAULT_ROUTINE_PERMISSION },
  )
  const [saving, setSaving] = useState(false)

  const canGenerate = description.trim().length > 0 && !!model && !generating

  const handleGenerate = async () => {
    if (!canGenerate || !model) return
    setGenerating(true)
    setError(null)
    try {
      // Language name in English, used in the system prompts sent to the model
      // (same as the desktop: LOCALE_PROMPT_NAME).
      const language = i18n.language.toLowerCase().startsWith('pt') ? 'Portuguese' : 'English'
      const result = await generate(description.trim(), model, folders, language, visionAvailable)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setSuggestion(result.suggestion)
      setTitle(result.suggestion.title)
      setPrompt(result.suggestion.prompt)
      setSchedule(result.suggestion.schedule)
      setModes(result.suggestion.modes)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const canSave =
    !!model &&
    title.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !!parseTime(schedule.time) &&
    !saving

  const handleCreate = async () => {
    if (!canSave || !model) return
    setSaving(true)
    try {
      const created = await create({
        title: title.trim(),
        prompt: prompt.trim(),
        schedule,
        model,
        // Vision only works with the vision model configured — if the user
        // turned the badge on in the review without one, the mode is created
        // off (the scheduler would have nothing to send in `visionModel`).
        modes: modes.vision && !visionModel ? { ...modes, vision: undefined } : modes,
        folders,
        visionModel: modes.vision ? (visionModel ?? undefined) : undefined,
        active: true,
      })
      onDone(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    if (!canSave || !model || !routine) return
    setSaving(true)
    try {
      await update(routine.id, {
        title: title.trim(),
        prompt: prompt.trim(),
        schedule,
        modes,
        model,
      })
      onDone({ ...routine, title: title.trim(), prompt: prompt.trim(), schedule, modes, model })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const reviewing = !!suggestion || !!routine
  const errorTint = { backgroundColor: hslToRgba(tokens.destructive.replace(/hsla?\(|\)/g, '').replace(/,/g, ''), 0.1) }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 64 }}
        keyboardShouldPersistTaps="handled"
      >
      {!reviewing ? (
        <>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('routines.create.describeHint')}</Text>
          <Textarea
            value={description}
            onChangeText={setDescription}
            placeholder={t('routines.create.placeholder')}
            placeholderTextColor={tokens.mutedForeground}
            style={{ minHeight: 120, maxHeight: 240 }}
            editable={!generating}
          />

          {error && (
            <View style={[s.errorBox, { borderColor: tokens.destructive }, errorTint]}>
              <AlertCircle size={14} color={tokens.destructive} />
              <Text style={[s.errorText, { color: tokens.destructive }]}>{error}</Text>
            </View>
          )}

          {generating && (
            <View style={[s.generatingBox, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-2/3" />
            </View>
          )}

          <View style={s.step1Row}>
            <View style={{ flex: 1 }}>
              <FolderSelector folders={folders} onFoldersChange={setFolders} />
            </View>
            <RoutineModelPicker value={model} onChange={setModel} />
          </View>
          {!model && <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('routines.create.noModel')}</Text>}

          <Pressable
            onPress={() => void handleGenerate()}
            disabled={!canGenerate}
            style={[s.primaryButton, { backgroundColor: tokens.primary }, !canGenerate && { opacity: 0.4 }]}
          >
            {generating ? (
              <ActivityIndicator size="small" color={tokens.primaryForeground} />
            ) : (
              <Sparkles size={16} color={tokens.primaryForeground} />
            )}
            <Text style={[s.buttonText, { color: tokens.primaryForeground }]}>
              {generating ? t('routines.create.generating') : t('routines.create.generate')}
            </Text>
          </Pressable>

          {folders.length === 0 && (
            <Text style={[s.hint, { color: tokens.mutedForeground }]}>
              {t('routines.review.noFolders')}
            </Text>
          )}
        </>
      ) : (
        <>
          {!routine && (
            <Pressable onPress={() => setSuggestion(null)} style={s.backRow}>
              <ArrowLeft size={14} color={tokens.mutedForeground} />
              <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('routines.review.back')}</Text>
            </Pressable>
          )}

          <Field label={t('routines.review.titleField')}>
            <Input value={title} onChangeText={setTitle} />
          </Field>

          <Field label={t('routines.review.promptField')} hint={t('routines.review.promptFieldHint')}>
            <Textarea value={prompt} onChangeText={setPrompt} style={{ minHeight: 100, maxHeight: 220 }} />
          </Field>

          <Field label={t('routines.review.schedule')}>
            <ScheduleEditor schedule={schedule} onChange={setSchedule} />
          </Field>

          <Field label={t('routines.review.modes')} hint={t('routines.review.modesHint')}>
            <ModesEditor modes={modes} onChange={setModes} />
          </Field>

          <Field label={t('routines.create.model')}>
            <RoutineModelPicker value={model} onChange={setModel} />
          </Field>

          <Field label={t('routines.review.folders')} hint={t('routines.review.foldersHint')}>
            {folders.length === 0 ? (
              <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('routines.review.noFolders')}</Text>
            ) : (
              <View style={{ gap: 4 }}>
                {folders.map((folder) => (
                  <View key={folder} style={s.folderRow}>
                    <Folder size={13} color={tokens.mutedForeground} />
                    <Text style={[s.folderText, { color: tokens.mutedForeground }]} numberOfLines={1}>
                      {folder}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </Field>

          {error && (
            <View style={[s.errorBox, { borderColor: tokens.destructive }, errorTint]}>
              <AlertCircle size={14} color={tokens.destructive} />
              <Text style={[s.errorText, { color: tokens.destructive }]}>{error}</Text>
            </View>
          )}

          <Pressable
            onPress={() => (routine ? void handleSave() : void handleCreate())}
            disabled={!canSave}
            style={[s.primaryButton, { backgroundColor: tokens.primary }, !canSave && { opacity: 0.4 }]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={tokens.primaryForeground} />
            ) : (
              <Sparkles size={16} color={tokens.primaryForeground} />
            )}
            <Text style={[s.buttonText, { color: tokens.primaryForeground }]}>
              {saving
                ? t('routines.list.saving')
                : routine
                  ? t('routines.list.save')
                  : t('routines.review.create')}
            </Text>
          </Pressable>
        </>
      )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.label, { color: tokens.foreground }]}>{label}</Text>
      {hint && <Text style={[s.hint, { color: tokens.mutedForeground }]}>{hint}</Text>}
      {children}
    </View>
  )
}

const s = StyleSheet.create({
  hint: { fontSize: 12, lineHeight: 17 },
  label: { fontSize: 14, fontWeight: '600' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
  },
  errorText: { flex: 1, fontSize: 12 },
  generatingBox: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  step1Row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 12,
  },
  buttonText: { fontSize: 14, fontWeight: '600' },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  linkText: { fontSize: 13 },
  folderRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  folderText: { fontSize: 12, flex: 1 },
})
