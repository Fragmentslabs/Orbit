/**
 * History of the Merge button — mirror of the desktop HistoryPanel: one card per
 * delivery with the tasks it carried. A tap on a task opens it (read-only).
 * Deleting a delivery removes the record, its archived tasks and the images they
 * stored — never automatic.
 */
import { useEffect } from 'react'
import { View, Text, Pressable, ScrollView, Alert, StyleSheet } from 'react-native'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, GitMerge, Trash2 } from 'lucide-react-native'
import type { Delivery } from '@orbit/shared'
import { usePipelineStore, EMPTY_TASKS } from '~/stores/pipeline-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { formatCost } from '~/lib/format'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { useCodeOnly } from '~/components/pipeline/use-code-only'

const NO_DELIVERIES: Delivery[] = []

export default function PipelineHistoryScreen() {
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  const { id } = useLocalSearchParams<{ id: string }>()
  const tasks = usePipelineStore((s) => s.tasksByPipeline[id ?? ''] ?? EMPTY_TASKS)
  const deliveries = usePipelineStore((s) => s.deliveriesByPipeline[id ?? ''] ?? NO_DELIVERIES)
  const loadDeliveries = usePipelineStore((s) => s.loadDeliveries)
  const deleteDelivery = usePipelineStore((s) => s.deleteDelivery)

  useEffect(() => {
    if (id) void loadDeliveries(id).catch(() => {})
  }, [id, loadDeliveries])

  const date = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })

  const confirmDelete = async (delivery: Delivery) => {
    const ok = await confirm({
      title: t('pipeline.history.confirmDelete', { number: delivery.number }),
      description: t('pipeline.history.confirmDeleteBody'),
      confirmLabel: t('pipeline.history.delete'),
      cancelLabel: t('sidebar.cancel'),
      destructive: true,
    })
    if (!ok) return
    if (id) void deleteDelivery(id, delivery.id).catch((err) => Alert.alert(String(err instanceof Error ? err.message : err)))
  }

  const ordered = [...deliveries].sort((a, b) => b.number - a.number)

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerButton} accessibilityLabel={t('pipeline.back')}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.title, { color: tokens.foreground }]}>{t('pipeline.history.title')}</Text>
          <Text style={[s.subtitle, { color: tokens.mutedForeground }]}>{t('pipeline.history.subtitle')}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 12, gap: 12, paddingBottom: 48 }}>
        {ordered.length === 0 && (
          <Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('pipeline.history.empty')}</Text>
        )}
        {ordered.map((delivery) => {
          const items = tasks.filter((x) => x.deliveryId === delivery.id)
          const cost = items.reduce((sum, x) => sum + x.cost, 0)
          return (
            <View key={delivery.id} style={[s.card, { borderColor: tokens.border }]}>
              <View style={[s.cardHeader, { borderBottomColor: tokens.border }]}>
                <GitMerge size={14} color={tokens.mutedForeground} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[s.cardTitle, { color: tokens.foreground }]} numberOfLines={1}>
                    {delivery.destination
                      ? t('pipeline.history.deliveryTo', { number: delivery.number, branch: delivery.destination })
                      : t('pipeline.history.delivery', { number: delivery.number })}
                  </Text>
                  <Text style={[s.cardMeta, { color: tokens.mutedForeground }]} numberOfLines={1}>
                    {date(delivery.createdAt)}
                    {delivery.mergeHash ? ` · ${delivery.mergeHash.slice(0, 7)}` : ''}
                    {cost > 0 ? ` · ${formatCost(cost)}` : ''}
                  </Text>
                </View>
                <Pressable
                  onPress={() => confirmDelete(delivery)}
                  accessibilityLabel={t('pipeline.history.delete')}
                  hitSlop={8}
                  style={s.iconButton}
                >
                  <Trash2 size={16} color={tokens.destructive} />
                </Pressable>
              </View>
              {items.map((task, index) => (
                <Pressable
                  key={task.id}
                  onPress={() =>
                    router.push({ pathname: '/(main)/pipeline/[id]/task/[taskId]', params: { id: id ?? '', taskId: task.id } })
                  }
                  style={[s.taskRow, index > 0 && { borderTopColor: tokens.border, borderTopWidth: StyleSheet.hairlineWidth }]}
                >
                  {task.number !== undefined && (
                    <Text style={[s.taskNumber, { color: tokens.mutedForeground }]}>#{task.number}</Text>
                  )}
                  <Text style={[s.taskTitle, { color: tokens.foreground }]} numberOfLines={1}>
                    {task.title}
                  </Text>
                  {(task.diff?.files.length ?? 0) > 0 && (
                    <Text style={[s.cardMeta, { color: tokens.mutedForeground }]}>
                      {t('pipeline.changedFiles', { count: task.diff!.files.length })}
                    </Text>
                  )}
                </Pressable>
              ))}
              {items.length === 0 && (
                <Text style={[s.noTasks, { color: tokens.mutedForeground }]}>{t('pipeline.history.noTasks')}</Text>
              )}
            </View>
          )
        })}
      </ScrollView>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1 },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 15, fontWeight: '600' },
  subtitle: { fontSize: 11 },
  empty: { fontSize: 13 },
  card: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1 },
  cardTitle: { fontSize: 13, fontWeight: '600' },
  cardMeta: { fontSize: 10 },
  iconButton: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  taskNumber: { fontSize: 12, fontFamily: 'Menlo' },
  taskTitle: { flex: 1, fontSize: 13 },
  noTasks: { fontSize: 11, paddingHorizontal: 12, paddingVertical: 10 },
})
