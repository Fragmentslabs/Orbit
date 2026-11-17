/**
 * The routine's settings — mirror of the desktop's RoutineSettings: one accordion row per group
 * (what, when, who, where, abilities), each closed row showing what is set today. There is no
 * Save button: a change settles for a moment and goes to the routine on its own.
 */
import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Folder, Shield, Sparkles, Users, CalendarClock } from 'lucide-react-native'
import type { Routine, RoutineModel, RoutineModes, Schedule } from '@orbit/shared'
import { ROUTINE_MODES, parseTime } from '@orbit/shared'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { FolderSelector } from '~/components/chat/FolderSelector'
import { useRoutinesStore } from '~/stores/routines-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { describeSchedule } from '~/lib/schedule'
import { ScheduleEditor, ModesEditor } from './schedule-editor'
import { RoutineModelPicker } from './routine-model-picker'

type Section = 'what' | 'when' | 'who' | 'where' | 'abilities'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const SAVE_DELAY_MS = 700

export function RoutineSettings({ routine }: { routine: Routine }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const update = useRoutinesStore((s) => s.update)
  const visionModel = useSettingsStore((s) => s.visionModel)
  const catalog = useSettingsStore((s) => s.catalog)

  const [title, setTitle] = useState(routine.title)
  const [prompt, setPrompt] = useState(routine.prompt)
  const [schedule, setSchedule] = useState<Schedule>(routine.schedule)
  const [modes, setModes] = useState<RoutineModes>(routine.modes)
  const [model, setModel] = useState<RoutineModel>(routine.model)
  const [folders, setFolders] = useState<string[]>(routine.folders)
  const [open, setOpen] = useState<Section | null>(null)
  const [status, setStatus] = useState<SaveState>('idle')

  const snapshot = JSON.stringify({ title, prompt, schedule, modes, model, folders })
  const saved = useRef(snapshot)
  const canSave = title.trim().length > 0 && prompt.trim().length > 0 && !!parseTime(schedule.time)

  const persist = () => {
    saved.current = snapshot
    setStatus('saving')
    update(routine.id, {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule,
      // Vision only works with the vision model configured (same rule as the form).
      modes: modes.vision && !visionModel && !routine.visionModel ? { ...modes, vision: undefined } : modes,
      model,
      folders,
    })
      .then(() => setStatus('saved'))
      .catch(() => setStatus('error'))
  }

  // Autosave: written after a short pause, so typing the prompt does not fire an update per key.
  // `saved` keeps the last written snapshot, so the echo of our own update never saves again.
  const latest = useRef({ snapshot, canSave, persist })
  useEffect(() => {
    latest.current = { snapshot, canSave, persist }
  })

  useEffect(() => {
    if (snapshot === saved.current || !canSave) return
    const timer = setTimeout(() => latest.current.persist(), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [snapshot, canSave])

  // Leaving the screen right after typing still writes the change.
  useEffect(
    () => () => {
      if (latest.current.canSave && latest.current.snapshot !== saved.current) latest.current.persist()
    },
    [],
  )

  const toggle = (section: Section) => setOpen((current) => (current === section ? null : section))
  const modelName = catalog?.[model.providerId]?.models[model.modelId]?.name ?? model.modelId
  const members = routine.team?.members.length ?? 0
  const activeModes = ROUTINE_MODES.filter((key) => modes[key] === true).map((key) => t(`routines.modes.${key}.name`))
  const folderLabel = folders[0] ? (folders[0].split(/[\\/]/).filter(Boolean).pop() ?? folders[0]) : '—'

  return (
    <View>
      <Disclosure icon={Sparkles} label={t('routines.detail.what')} value={title} open={open === 'what'} onToggle={() => toggle('what')}>
        <View style={{ gap: 10 }}>
          <Field label={t('routines.review.titleField')}>
            <Input value={title} onChangeText={setTitle} />
          </Field>
          <Field label={t('routines.review.promptField')}>
            <Textarea value={prompt} onChangeText={setPrompt} style={{ minHeight: 100, maxHeight: 220 }} />
          </Field>
        </View>
      </Disclosure>

      <Disclosure
        icon={CalendarClock}
        label={t('routines.detail.when')}
        value={describeSchedule(schedule, t)}
        open={open === 'when'}
        onToggle={() => toggle('when')}
      >
        <ScheduleEditor schedule={schedule} onChange={setSchedule} />
      </Disclosure>

      <Disclosure
        icon={Users}
        label={t('routines.detail.who')}
        value={members > 0 ? t('routines.detail.agentCount', { count: members }) : modelName}
        open={open === 'who'}
        onToggle={() => toggle('who')}
      >
        <Field label={t('routines.detail.model')}>
          <RoutineModelPicker value={model} onChange={(next) => next && setModel(next)} />
        </Field>
      </Disclosure>

      <Disclosure icon={Folder} label={t('routines.detail.where')} value={folderLabel} open={open === 'where'} onToggle={() => toggle('where')}>
        <View style={{ gap: 8 }}>
          <FolderSelector folders={folders} onFoldersChange={setFolders} />
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('routines.review.foldersHint')}</Text>
        </View>
      </Disclosure>

      <Disclosure
        icon={Shield}
        label={t('routines.detail.abilities')}
        value={activeModes.join(', ')}
        open={open === 'abilities'}
        onToggle={() => toggle('abilities')}
      >
        <ModesEditor modes={modes} onChange={setModes} />
      </Disclosure>

      <View style={s.status}>
        {status === 'saved' && <Check size={13} color="#15803d" />}
        <Text style={[s.hint, { color: status === 'error' ? tokens.destructive : tokens.mutedForeground }]}>
          {status === 'saving'
            ? t('routines.detail.saving')
            : status === 'error'
              ? t('routines.detail.saveError')
              : t('routines.detail.saved')}
        </Text>
      </View>
    </View>
  )
}

/** One line of the settings: icon, name, what is set today and the chevron that opens it. */
function Disclosure({
  icon: Icon,
  label,
  value,
  open,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>
  label: string
  value?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: tokens.border, backgroundColor: open ? tokens.card : undefined }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={s.row}
      >
        <Icon size={18} color={open ? tokens.primary : tokens.mutedForeground} />
        <Text style={[s.rowLabel, { color: tokens.foreground }, open && { fontWeight: '600' }]}>{label}</Text>
        {!open && !!value && (
          <Text numberOfLines={1} style={[s.rowValue, { color: tokens.mutedForeground }]}>
            {value}
          </Text>
        )}
        {/* Never squeezed out by a long value: the chevron is what says the row opens. */}
        <View style={{ flexShrink: 0 }}>
          <ChevronDown size={16} color={tokens.mutedForeground} style={open ? { transform: [{ rotate: '180deg' }] } : undefined} />
        </View>
      </Pressable>
      {open && <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 18 }}>{children}</View>}
    </View>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.fieldLabel, { color: tokens.foreground }]}>{label}</Text>
      {children}
    </View>
  )
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16 },
  rowLabel: { flex: 1, fontSize: 15 },
  rowValue: { maxWidth: 140, fontSize: 13 },
  fieldLabel: { fontSize: 13, fontWeight: '500' },
  hint: { fontSize: 12, lineHeight: 17 },
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14 },
})
