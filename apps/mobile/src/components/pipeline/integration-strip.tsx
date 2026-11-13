/**
 * The strip under the board header — mirror of the desktop IntegrationBar plus
 * the pipeline model control: the integration branch at a glance, the pipeline
 * model, the history and the Merge button (a split button — the arrow picks the
 * destination). In simple mode (no worktrees) the same place holds "Archive
 * completed".
 *
 * Merge never pushes: it moves a local branch. If the integration has loose
 * changes it stops and offers to commit them (the pipeline model writes the
 * message) or to cancel. Everything runs on the desktop.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { Brain, ChevronDown, GitBranch, GitMerge, History } from 'lucide-react-native'
import type { IntegrationStatus, Pipeline, Task } from '@orbit/shared'
import { pipelineFlow, pipelineModel } from '@orbit/shared'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { ModelPickerModal } from '~/components/chat/ModelPickerModal'
import { ProviderLogo } from '~/components/ui/provider-logo'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useSettingsStore } from '~/stores/settings-store'
import { usePipelineStore } from '~/stores/pipeline-store'

export function IntegrationStrip({ pipeline, tasks }: { pipeline: Pipeline; tasks: Task[] }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const catalog = useSettingsStore((s) => s.catalog)
  const flow = pipelineFlow(pipeline)

  const store = usePipelineStore.getState
  const updatePipeline = usePipelineStore((s) => s.updatePipeline)
  const archiveCompleted = usePipelineStore((s) => s.archiveCompleted)

  const [status, setStatus] = useState<IntegrationStatus | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [defaultBranch, setDefaultBranch] = useState<string | undefined>()
  const [destination, setDestination] = useState<string | null>(null)
  const [busy, setBusy] = useState<'merge' | 'commit' | 'archive' | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [branchesOpen, setBranchesOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)

  // Refresh when anything that changes the strip does: a task entering the
  // queue, being merged, or the pipeline getting its integration worktree.
  const signature = useMemo(
    () =>
      tasks.map((x) => `${x.id}:${x.status}:${x.integration?.state ?? ''}:${x.deliveryId ? 1 : 0}`).join('|') +
      `|${pipeline.integration?.branch ?? ''}`,
    [tasks, pipeline.integration?.branch],
  )

  const refresh = useCallback(async () => {
    if (flow === 'simple') return
    try {
      setStatus(await store().integrationStatus(pipeline.id))
    } catch {
      // Desktop unreachable: keep what is on screen.
    }
  }, [flow, pipeline.id, store])

  useEffect(() => {
    if (flow === 'simple') return
    let cancelled = false
    store()
      .integrationStatus(pipeline.id)
      .then((next) => !cancelled && setStatus(next))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [flow, pipeline.id, signature, store])

  useEffect(() => {
    if (flow === 'simple') return
    store()
      .destinations(pipeline.id)
      .then((d) => {
        setBranches(d.branches)
        setDefaultBranch(d.default)
      })
      .catch(() => {})
  }, [flow, pipeline.id, signature, store])

  const model = pipelineModel(pipeline)
  const modelName = model ? (catalog?.[model.providerId]?.models[model.modelId]?.name ?? model.modelId) : null
  const target = destination ?? defaultBranch
  const pendingCompleted = tasks.filter((x) => x.status === 'completed' && !x.deliveryId).length
  const nothingToMerge = !status || (status.ahead === 0 && status.dirty.length === 0)
  const mergeDisabled = !target || busy !== null || nothingToMerge

  const changeModel = (providerId: string, modelId: string) => {
    const previous = pipelineModel(pipeline)
    void updatePipeline(pipeline.id, {
      model: { providerId, modelId, reasoning: null },
      // Phases that used the old pipeline model follow it; the ones with a model
      // of their own keep it.
      phases: pipeline.phases.map((phase) =>
        previous && phase.providerId === previous.providerId && phase.modelId === previous.modelId
          ? { ...phase, providerId, modelId, reasoning: null }
          : phase,
      ),
    }).catch((err) => setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
  }

  const merge = async () => {
    if (!target || busy) return
    setBusy('merge')
    setMessage(null)
    try {
      const outcome = await store().merge(pipeline.id, target)
      if (outcome.status === 'delivered') {
        setMessage({ kind: 'ok', text: t('pipeline.merge.done', { branch: target, count: outcome.delivery.taskIds.length }) })
      } else if (outcome.status === 'dirty') {
        askToCommit()
      } else if (outcome.status === 'blocked') {
        setMessage({
          kind: 'error',
          text: t('pipeline.merge.blocked', { branch: target, where: outcome.where, files: outcome.files.join(', ') }),
        })
      } else {
        setMessage({ kind: 'error', text: outcome.message })
      }
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const askToCommit = async () => {
    const ok = await confirm({
      title: t('pipeline.merge.dirtyTitle'),
      description: t('pipeline.merge.dirtyBody'),
      confirmLabel: t('pipeline.merge.commit'),
      cancelLabel: t('sidebar.cancel'),
    })
    if (ok) void commitThenMerge()
  }

  const commitThenMerge = async () => {
    setBusy('commit')
    try {
      const result = await store().commitIntegration(pipeline.id)
      if (!result.ok) {
        setMessage({ kind: 'error', text: result.error ?? t('pipeline.merge.commitFailed') })
        return
      }
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      return
    } finally {
      setBusy(null)
    }
    await merge()
  }

  const archive = async () => {
    setBusy('archive')
    try {
      await archiveCompleted(pipeline.id)
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const openHistory = () => router.push({ pathname: '/(main)/pipeline/[id]/history', params: { id: pipeline.id } })

  return (
    <View style={[s.strip, { backgroundColor: tokens.muted, borderColor: tokens.border }]}>
      {/* Row 1: the integration branch and its state */}
      <View style={s.infoRow}>
        {flow !== 'simple' ? (
          <>
            <GitBranch size={13} color={tokens.mutedForeground} />
            <Text style={[s.branch, { color: tokens.foreground }]} numberOfLines={1}>
              {status?.branch ?? t('pipeline.merge.notCreated')}
            </Text>
            {status && (
              <Text style={[s.info, { color: tokens.mutedForeground }]} numberOfLines={1}>
                {t('pipeline.merge.ahead', { count: status.ahead, base: status.base })}
              </Text>
            )}
          </>
        ) : (
          <Text style={[s.info, { color: tokens.mutedForeground }]}>{t('pipeline.merge.simpleMode')}</Text>
        )}
      </View>
      {status && (status.queued > 0 || status.dirty.length > 0) && (
        <View style={s.infoRow}>
          {status.queued > 0 && (
            <>
              <ActivityIndicator size="small" color={tokens.primary} />
              <Text style={[s.info, { color: tokens.primary }]}>{t('pipeline.merge.queued', { count: status.queued })}</Text>
            </>
          )}
          {status.dirty.length > 0 && (
            <Text style={[s.info, { color: '#d97706' }]}>{t('pipeline.merge.uncommitted', { count: status.dirty.length })}</Text>
          )}
        </View>
      )}

      {/* Row 2: model, history and merge */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.actions}>
        <Pressable
          onPress={() => setModelOpen(true)}
          accessibilityLabel={t('pipeline.defaultModel')}
          style={[s.chip, { backgroundColor: tokens.background, borderColor: tokens.border }]}
        >
          {model ? (
            <ProviderLogo providerId={model.providerId} size={13} color={tokens.mutedForeground} />
          ) : (
            <Brain size={13} color={tokens.mutedForeground} />
          )}
          <Text style={[s.chipText, { color: tokens.foreground }]} numberOfLines={1}>
            {modelName ?? t('pipeline.defaultModel')}
          </Text>
          <ChevronDown size={13} color={tokens.mutedForeground} />
        </Pressable>

        <Pressable
          onPress={openHistory}
          accessibilityLabel={t('pipeline.history.open')}
          style={[s.chip, { backgroundColor: tokens.background, borderColor: tokens.border }]}
        >
          <History size={13} color={tokens.mutedForeground} />
          <Text style={[s.chipText, { color: tokens.foreground }]}>{t('pipeline.history.title')}</Text>
        </Pressable>

        {flow === 'simple' ? (
          pendingCompleted > 0 && (
            <Pressable
              onPress={() => void archive()}
              disabled={busy === 'archive'}
              style={[s.chip, { backgroundColor: tokens.background, borderColor: tokens.border }]}
            >
              <Text style={[s.chipText, { color: tokens.foreground }]}>
                {t('pipeline.history.archiveCompleted', { count: pendingCompleted })}
              </Text>
            </Pressable>
          )
        ) : (
          <View style={[s.group, mergeDisabled && { opacity: 0.5 }]}>
            <Pressable
              onPress={() => void merge()}
              disabled={mergeDisabled}
              accessibilityLabel={t('pipeline.merge.hint', { branch: target ?? '…' })}
              style={[s.groupMain, { backgroundColor: tokens.primary, borderColor: tokens.primary }]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={tokens.primaryForeground} />
              ) : (
                <GitMerge size={14} color={tokens.primaryForeground} />
              )}
              <Text style={[s.groupText, { color: tokens.primaryForeground }]} numberOfLines={1}>
                {target ? t('pipeline.merge.into', { branch: target }) : t('pipeline.merge.button')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setBranchesOpen(true)}
              disabled={busy !== null || branches.length === 0}
              accessibilityLabel={t('pipeline.merge.chooseBranch')}
              style={[s.groupArrow, { backgroundColor: tokens.primary, borderColor: tokens.primary }]}
            >
              <ChevronDown size={14} color={tokens.primaryForeground} />
            </Pressable>
          </View>
        )}
      </ScrollView>

      {message && (
        <Text
          style={[s.message, { color: message.kind === 'error' ? tokens.destructive : '#10b981' }]}
          numberOfLines={4}
        >
          {message.text}
        </Text>
      )}

      <ModelPickerModal
        visible={modelOpen}
        onClose={() => setModelOpen(false)}
        selected={model ? { providerId: model.providerId, modelId: model.modelId } : null}
        onSelect={changeModel}
      />

      <BottomSheet
        open={branchesOpen}
        onClose={() => setBranchesOpen(false)}
        title={<Text style={[s.sheetTitle, { color: tokens.foreground }]}>{t('pipeline.merge.chooseBranch')}</Text>}
      >
        <ScrollView style={{ maxHeight: 420 }}>
          {branches.map((branch) => (
            <Pressable
              key={branch}
              onPress={() => {
                setDestination(branch)
                setBranchesOpen(false)
              }}
              style={[s.branchRow, { borderBottomColor: tokens.border }]}
            >
              <GitBranch size={14} color={tokens.mutedForeground} />
              <Text style={[s.branchName, { color: tokens.foreground }]} numberOfLines={1}>
                {branch}
              </Text>
              {branch === target && <Text style={{ color: tokens.primary }}>✓</Text>}
            </Pressable>
          ))}
        </ScrollView>
      </BottomSheet>
    </View>
  )
}

const s = StyleSheet.create({
  strip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  branch: { fontSize: 12, fontFamily: 'Menlo', flexShrink: 1 },
  info: { fontSize: 11 },
  actions: { alignItems: 'center', gap: 8, paddingRight: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 200,
  },
  chipText: { fontSize: 12, fontWeight: '500', flexShrink: 1 },
  group: { flexDirection: 'row', alignItems: 'center' },
  groupMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderTopLeftRadius: 8,
    borderBottomLeftRadius: 8,
    maxWidth: 220,
  },
  groupText: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
  groupArrow: {
    height: 32,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginLeft: -1,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
  },
  message: { fontSize: 11 },
  sheetTitle: { fontSize: 15, fontWeight: '600' },
  branchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  branchName: { flex: 1, fontSize: 14 },
})
