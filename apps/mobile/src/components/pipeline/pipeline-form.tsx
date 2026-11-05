/**
 * Pipeline create/edit form — mirror of the desktop PipelineCreateDialog as a
 * route: name, folders (FolderSelector), default model, phases (add from the
 * templates via bottom sheet, reorder by drag & drop, edit, remove) and the
 * push/screenshots toggles. On creation the project is born together (owner of
 * the folders), with the same name — same flow as the desktop.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native'
import { useTranslation } from 'react-i18next'
import Animated from 'react-native-reanimated'
import { Brain, ChevronDown, GripVertical, Pencil, Plus, Settings2, X } from 'lucide-react-native'
import type { Pipeline, PhaseChoice, PhaseConfig, PhaseTemplate } from '@orbit/shared'
import { PIPELINE_COMMIT_PROMPT_DEFAULT } from '@orbit/shared'
import { Input } from '~/components/ui/input'
import { Switch } from '~/components/ui/switch'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { FolderSelector } from '~/components/chat/FolderSelector'
import { ModelPickerModal } from '~/components/chat/ModelPickerModal'
import { ProviderLogo } from '~/components/ui/provider-logo'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useSettingsStore } from '~/stores/settings-store'
import { usePipelineStore } from '~/stores/pipeline-store'
import { PhaseEditor } from './phase-editor'
import { LoadError } from './load-error'
import { fromTemplate, templateLabel } from './pipeline-utils'
import { DraggablePhaseRow, PhaseListDragProvider, usePhaseListDrag } from './phase-list-drag'

interface ChosenModel {
  providerId: string
  modelId: string
}

/** Phase in the form with a stable key — identity survives DnD reorderings
 *  (index-based keys would unmount the rows in the middle of the drag). */
interface LocalPhase extends PhaseChoice {
  rowKey: string
}

let keySeq = 0
const withKey = (phase: PhaseChoice): LocalPhase => ({
  ...phase,
  rowKey: `phase_${++keySeq}_${Date.now().toString(36)}`,
})

interface PipelineFormProps {
  /** Pipeline being edited — absent = a new one. */
  editing?: Pipeline | null
  onDone: (pipeline: Pipeline) => void
  onCancel: () => void
}

export function PipelineForm(props: PipelineFormProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const loaded = usePipelineStore((s) => s.loaded)
  const error = usePipelineStore((s) => s.error)
  const fetch = usePipelineStore((s) => s.fetch)

  useEffect(() => {
    if (!loaded) void fetch()
  }, [loaded, fetch])

  // The form needs the templates to build the initial phases — it only mounts
  // after the snapshot arrives, and the initial state comes straight from the
  // props/store (no reset effect). A failed fetch becomes a screen with retry
  // (never an endless spinner).
  if (!loaded) {
    if (error) {
      return <LoadError />
    }
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    )
  }
  return <LoadedPipelineForm {...props} />
}

/** Owner of the phase state: PhaseListDragProvider needs onMove in the scope
 *  that mounts the provider (the drag context must be available to the body). */
function LoadedPipelineForm(props: PipelineFormProps) {
  const { t } = useTranslation()
  const templates = usePipelineStore((s) => s.templates)

  // Editing starts from the REAL phases of the pipeline (already copies, D4); a
  // new one starts only with the default phases — the others stay behind the "+".
  const [phases, setPhases] = useState<LocalPhase[]>(() =>
    props.editing
      ? props.editing.phases.map((p) =>
          withKey({
            templateId: templates.find((tpl) => tpl.name === p.name)?.id,
            name: p.name,
            description: p.description,
            prompt: p.prompt,
            tools: [...p.tools],
            kind: p.kind ?? 'generic',
          }),
        )
      : templates.filter((tpl) => tpl.isDefault).map((tpl) => withKey(fromTemplate(tpl, t))),
  )

  const move = useCallback((from: number, to: number) => {
    setPhases((current) => {
      if (from === to || from < 0 || to < 0 || from >= current.length || to > current.length) return current
      const next = [...current]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [setPhases])

  return (
    <PhaseListDragProvider phases={phases} onMove={move}>
      <PipelineFormBody {...props} phases={phases} setPhases={setPhases} />
    </PhaseListDragProvider>
  )
}

function PipelineFormBody({
  editing,
  onDone,
  onCancel,
  phases,
  setPhases,
}: PipelineFormProps & {
  phases: LocalPhase[]
  setPhases: React.Dispatch<React.SetStateAction<LocalPhase[]>>
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const catalog = useSettingsStore((s) => s.catalog)

  const templates = usePipelineStore((s) => s.templates)
  const projects = usePipelineStore((s) => s.projects)
  const createProject = usePipelineStore((s) => s.createProject)
  const updateProject = usePipelineStore((s) => s.updateProject)
  const createPipeline = usePipelineStore((s) => s.createPipeline)
  const updatePipeline = usePipelineStore((s) => s.updatePipeline)
  const saveTemplate = usePipelineStore((s) => s.saveTemplate)

  const { scrollViewRef, handleScroll, handleScrollEnd, contentHeight } = usePhaseListDrag()

  const [name, setName] = useState(editing?.name ?? '')
  const [folders, setFolders] = useState<string[]>(
    editing ? (projects.find((p) => p.id === editing.projectId)?.folders ?? []) : [],
  )
  const [commitAtEnd, setCommitAtEnd] = useState(editing?.commitAtEnd !== false)
  const [commitPrompt, setCommitPrompt] = useState(editing?.commitPrompt ?? '')
  const [promptOpen, setPromptOpen] = useState(false)
  // Editing starts from the REAL model of the pipeline (every phase shares it);
  // without this the form opened with no model and the "Default model" stayed empty.
  const [model, setModel] = useState<ChosenModel | null>(() =>
    editing?.phases[0]
      ? { providerId: editing.phases[0].providerId, modelId: editing.phases[0].modelId }
      : null,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [addPhaseOpen, setAddPhaseOpen] = useState(false)
  const [editingPhase, setEditingPhase] = useState<{ index: number | null; phase: PhaseChoice | null } | null>(null)

  const modelName = model
    ? (catalog?.[model.providerId]?.models[model.modelId]?.name ?? model.modelId)
    : null

  const available = templates.filter((tpl) => !phases.some((p) => p.templateId === tpl.id))

  const savePhase = useCallback(
    async (phase: PhaseChoice, saveAsDefault: boolean) => {
      const index = editingPhase?.index ?? null
      setPhases((current) =>
        index == null
          ? [...current, withKey(phase)]
          : current.map((p, i) => (i === index ? { ...phase, rowKey: p.rowKey } : p)),
      )
      if (saveAsDefault && phase.templateId) {
        await saveTemplate({
          id: phase.templateId,
          name: phase.name,
          description: phase.description,
          prompt: phase.prompt,
          tools: phase.tools,
          kind: phase.kind,
          // Keeps the phase among the suggested ones if it already was, so the
          // default does not disappear
          isDefault: templates.find((tpl) => tpl.id === phase.templateId)?.isDefault ?? false,
        })
      }
      setEditingPhase(null)
    },
    [editingPhase, templates, saveTemplate, setPhases],
  )

  const canSubmit =
    name.trim().length > 0 && phases.length > 0 && !!model && folders.length > 0 && !saving

  const submit = async () => {
    if (!canSubmit || !model) return
    setSaving(true)
    setError(null)
    try {
      if (editing) {
        // Editing does not recreate the pipeline: it keeps the id, tasks and
        // history. The phases become PhaseConfig keeping the model already
        // configured per phase.
        const original = editing.phases[0]
        const modelChanged =
          !original || original.providerId !== model.providerId || original.modelId !== model.modelId
        await updatePipeline(editing.id, {
          name: name.trim(),
          commitAtEnd,
          ...(commitPrompt.trim() ? { commitPrompt: commitPrompt.trim() } : { commitPrompt: '' }),
          phases: phases.map((phase, order): PhaseConfig => {
            const previous = editing.phases[order]
            // Changing the "Default model" changes the model of every phase.
            // Without a change, each phase keeps the model and the reasoning it
            // has (the desktop allows one per phase).
            const keep = !modelChanged && !!previous
            return {
              id: previous?.id ?? `phase_${order}_${Date.now().toString(36)}`,
              name: phase.name,
              description: phase.description,
              prompt: phase.prompt,
              providerId: keep ? previous.providerId : model.providerId,
              modelId: keep ? previous.modelId : model.modelId,
              thinkingLevel: previous?.thinkingLevel ?? 0,
              reasoning: keep ? (previous.reasoning ?? null) : null,
              ...(phase.templateId ? { templateId: phase.templateId } : {}),
              tools: [...phase.tools],
              kind: phase.kind,
              order,
            }
          }),
        })
        await updateProject(editing.projectId, { folders })
        onDone(editing)
        return
      }
      // The project owns the folders — it is born together, with the same name.
      const project = await createProject(name.trim(), folders)
      const pipeline = await createPipeline({
        projectId: project.id,
        name: name.trim(),
        phases: phases.map(({ rowKey: _rowKey, ...phase }) => phase),
        providerId: model.providerId,
        modelId: model.modelId,
        commitAtEnd,
        ...(commitPrompt.trim() ? { commitPrompt: commitPrompt.trim() } : {}),
      })
      onDone(pipeline)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Animated.ScrollView
        ref={scrollViewRef}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onScrollEndDrag={handleScrollEnd}
        onMomentumScrollEnd={handleScrollEnd}
        contentContainerStyle={{ minHeight: contentHeight, padding: 16, gap: 14, paddingBottom: 64 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.field}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.pipelineName')}</Text>
          <Input value={name} onChangeText={setName} placeholder={t('pipeline.nameExample')} />
        </View>

        <View style={s.field}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.folders')}</Text>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.foldersHint')}</Text>
          <FolderSelector folders={folders} onFoldersChange={setFolders} />
          {folders.length > 0 && (
            <Text style={[s.hint, { color: tokens.mutedForeground }]} numberOfLines={1}>
              {t('pipeline.mainRepository')}: <Text style={{ color: tokens.foreground }}>{folders[0]}</Text>
            </Text>
          )}
        </View>

        <View style={s.field}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.defaultModel')}</Text>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.modelHint')}</Text>
          <Pressable
            onPress={() => setModelPickerOpen(true)}
            style={({ pressed }) => [
              s.modelTrigger,
              { backgroundColor: pressed ? tokens.muted : tokens.card, borderColor: tokens.border },
            ]}
          >
            <View style={s.modelTriggerLeft}>
              {model?.providerId ? (
                <ProviderLogo providerId={model.providerId} size={14} color={tokens.mutedForeground} />
              ) : (
                <Brain size={14} color={tokens.mutedForeground} />
              )}
              <Text style={[s.modelText, { color: modelName ? tokens.foreground : tokens.mutedForeground }]} numberOfLines={1}>
                {modelName ?? t('pipeline.defaultModel')}
              </Text>
            </View>
            <ChevronDown size={15} color={tokens.mutedForeground} />
          </Pressable>
        </View>

        <View style={s.field}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.phases')}</Text>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.phasesHint')}</Text>
          {/* The sortable rows are position:absolute (the lib positions them via
              top) — the wrapper needs the exact height of the list, otherwise
              what comes after (add phase, switches) flows over the cards. */}
          <View style={{ height: contentHeight }}>
            {phases.map((phase, index) => (
              <DraggablePhaseRow key={phase.rowKey} rowKey={phase.rowKey} index={index}>
                <PhaseRowContent
                  phase={phase}
                  tokens={tokens}
                  onEdit={() => setEditingPhase({ index, phase })}
                  onRemove={() => setPhases((current) => current.filter((_, i) => i !== index))}
                />
              </DraggablePhaseRow>
            ))}
          </View>
          <Pressable
            onPress={() => setAddPhaseOpen(true)}
            style={[s.addPhase, { borderColor: tokens.border }]}
          >
            <Plus size={13} color={tokens.mutedForeground} />
            <Text style={[s.addPhaseText, { color: tokens.mutedForeground }]}>
              {t('pipeline.addPhase')}
            </Text>
          </Pressable>
        </View>

        <View style={{ gap: 10 }}>
          <View style={s.switchRow}>
            <Switch checked={commitAtEnd} onCheckedChange={setCommitAtEnd} />
            <Text style={[s.switchText, { color: tokens.foreground }]}>{t('pipeline.commit')}</Text>
            <Pressable onPress={() => setPromptOpen(true)} hitSlop={8}>
              <Settings2 size={14} color={tokens.mutedForeground} />
            </Pressable>
          </View>
        </View>

        {error && (
          <Text style={[s.error, { color: tokens.destructive }]}>{error}</Text>
        )}

        <View style={s.footer}>
          <Pressable onPress={onCancel} style={s.secondaryButton}>
            <Text style={[s.secondaryButtonText, { color: tokens.foreground }]}>{t('sidebar.cancel')}</Text>
          </Pressable>
          <Pressable
            onPress={() => void submit()}
            disabled={!canSubmit}
            style={[s.primaryButton, { backgroundColor: tokens.primary, opacity: canSubmit ? 1 : 0.4 }]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={tokens.primaryForeground} />
            ) : (
              <Text style={[s.primaryButtonText, { color: tokens.primaryForeground }]}>
                {editing ? t('pipeline.save') : t('pipeline.create')}
              </Text>
            )}
          </Pressable>
        </View>
      </Animated.ScrollView>

      <ModelPickerModal
        visible={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        selected={model}
        onSelect={(providerId, modelId) => setModel({ providerId, modelId })}
      />

      <BottomSheet
        open={addPhaseOpen}
        onClose={() => setAddPhaseOpen(false)}
        title={
          <Text style={[s.sheetTitle, { color: tokens.foreground }]}>{t('pipeline.addPhase')}</Text>
        }
      >
        <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
          {available.map((tpl: PhaseTemplate) => {
            const label = templateLabel(tpl, t)
            return (
              <Pressable
                key={tpl.id}
                onPress={() => {
                  setPhases((current) => [...current, withKey(fromTemplate(tpl, t))])
                  setAddPhaseOpen(false)
                }}
                style={[s.phaseOption, { borderBottomColor: tokens.border }]}
              >
                <Text style={[s.phaseOptionName, { color: tokens.foreground }]} numberOfLines={1}>
                  {label.name}
                </Text>
                <Text style={[s.phaseOptionDescription, { color: tokens.mutedForeground }]} numberOfLines={2}>
                  {label.description}
                </Text>
              </Pressable>
            )
          })}
          <Pressable
            onPress={() => {
              setAddPhaseOpen(false)
              setEditingPhase({ index: null, phase: null })
            }}
            style={[s.phaseOption, { borderBottomWidth: 0 }]}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Plus size={14} color={tokens.foreground} />
              <Text style={[s.phaseOptionName, { color: tokens.foreground }]}>{t('pipeline.createPhase')}</Text>
            </View>
          </Pressable>
        </ScrollView>
      </BottomSheet>

      {editingPhase && (
        <PhaseEditor
          key={`${editingPhase.index ?? 'new'}-${editingPhase.phase?.templateId ?? 'custom'}`}
          phase={editingPhase.phase}
          onClose={() => setEditingPhase(null)}
          onSave={savePhase}
        />
      )}

      {/* Final commit prompt: empty = default (what the task asks for; without
          it, the style of the most recent commit; without history, memory;
          fallback Conventional Commits). */}
      <BottomSheet
        open={promptOpen}
        onClose={() => setPromptOpen(false)}
        title={
          <Text style={[s.sheetTitle, { color: tokens.foreground }]}>
            {t('pipeline.commitPromptTitle')}
          </Text>
        }
      >
        <View style={{ gap: 10, paddingBottom: 24 }}>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>
            {t('pipeline.commitPromptHint')}
          </Text>
          <Input
            value={commitPrompt}
            onChangeText={setCommitPrompt}
            placeholder={PIPELINE_COMMIT_PROMPT_DEFAULT}
            multiline
            textAlignVertical="top"
            style={{ height: 180 }}
          />
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>
            {t('pipeline.commitPromptEmpty')}
          </Text>
        </View>
      </BottomSheet>
    </KeyboardAvoidingView>
  )
}

/** Phase row: handle (drag), name/description (tap opens the editor), pencil
 *  and remove. The drag itself comes from DraggablePhaseRow on top. */
function PhaseRowContent({
  phase,
  tokens,
  onEdit,
  onRemove,
}: {
  phase: PhaseChoice
  tokens: Record<string, string>
  onEdit?: () => void
  onRemove?: () => void
}) {
  return (
    <View style={[s.phaseRow, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <GripVertical size={14} color={tokens.mutedForeground} style={{ opacity: 0.55 }} />
      <Pressable onPress={onEdit} disabled={!onEdit} style={{ minWidth: 0, flex: 1, gap: 1 }}>
        <Text style={[s.phaseName, { color: tokens.foreground }]} numberOfLines={1}>
          {phase.name}
        </Text>
        <Text style={[s.phaseDescription, { color: tokens.mutedForeground }]} numberOfLines={1}>
          {phase.description}
        </Text>
      </Pressable>
      <Pressable onPress={onEdit} disabled={!onEdit} hitSlop={8}>
        <Pencil size={14} color={tokens.mutedForeground} />
      </Pressable>
      <Pressable onPress={onRemove} disabled={!onRemove} hitSlop={8}>
        <X size={14} color={tokens.mutedForeground} />
      </Pressable>
    </View>
  )
}

const s = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: '600' },
  hint: { fontSize: 11, lineHeight: 15 },
  modelTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  modelTriggerLeft: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1, minWidth: 0 },
  modelText: { fontSize: 13, fontWeight: '500', flex: 1 },
  addPhase: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    paddingVertical: 8,
    marginTop: 8,
  },
  addPhaseText: { fontSize: 11 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchText: { fontSize: 13 },
  error: { fontSize: 12, lineHeight: 17 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  secondaryButton: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  secondaryButtonText: { fontSize: 13, fontWeight: '500' },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  primaryButtonText: { fontSize: 13, fontWeight: '600' },
  phaseOption: { paddingVertical: 10, borderBottomWidth: 1 },
  phaseOptionName: { fontSize: 13, fontWeight: '500' },
  phaseOptionDescription: { fontSize: 11, lineHeight: 15, marginTop: 1 },
  phaseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  phaseName: { fontSize: 12, fontWeight: '500' },
  phaseDescription: { fontSize: 11 },
  sheetTitle: { fontSize: 16, fontWeight: '600', marginBottom: 10 },
})
