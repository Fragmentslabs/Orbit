/**
 * Plan tasks — mirror of the desktop TaskPlanDialog as a route. Step 1: describe
 * what you want and the pipeline model proposes tasks. Step 2: review (drop what
 * you don't want) and approve; nothing is created before that. "Fill in by hand"
 * leaves for the manual form.
 */
import { useEffect, useState } from 'react'
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
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, X } from 'lucide-react-native'
import type { PlannedTask } from '@orbit/shared'
import { usePipelineStore } from '~/stores/pipeline-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { Textarea } from '~/components/ui/textarea'
import { LoadError } from '~/components/pipeline/load-error'
import { useCodeOnly } from '~/components/pipeline/use-code-only'

/** Removes one proposed task and renumbers the dependencies of the others. */
function withoutTask(tasks: PlannedTask[], removed: number): PlannedTask[] {
  return tasks
    .filter((_, index) => index !== removed)
    .map((task) => ({
      ...task,
      dependsOn: task.dependsOn.filter((dep) => dep !== removed).map((dep) => (dep > removed ? dep - 1 : dep)),
    }))
}

export default function PlanTasksScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  const { id } = useLocalSearchParams<{ id: string }>()
  const pipeline = usePipelineStore((s) => s.pipelines.find((p) => p.id === id))
  const loaded = usePipelineStore((s) => s.loaded)
  const error = usePipelineStore((s) => s.error)
  const fetch = usePipelineStore((s) => s.fetch)
  const planTasks = usePipelineStore((s) => s.planTasks)
  const createPlanned = usePipelineStore((s) => s.createPlanned)

  const [request, setRequest] = useState('')
  const [plan, setPlan] = useState<PlannedTask[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) void fetch()
  }, [loaded, fetch])

  useEffect(() => {
    if (loaded && !pipeline) router.back()
  }, [loaded, pipeline, router])

  if (!pipeline) {
    return (
      <SafeScreen style={{ flex: 1 }}>
        {error ? (
          <LoadError />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={tokens.primary} />
          </View>
        )}
      </SafeScreen>
    )
  }

  const propose = async () => {
    if (!request.trim() || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const proposed = await planTasks(pipeline.id, request.trim())
      if (proposed.length === 0) setFailure(t('pipeline.planFailed'))
      else setPlan(proposed)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!plan || plan.length === 0 || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await createPlanned(pipeline.id, plan)
      router.back()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable
          onPress={() => (plan ? setPlan(null) : router.back())}
          style={s.headerButton}
          accessibilityLabel={t(plan ? 'pipeline.plan.back' : 'pipeline.back')}
        >
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('pipeline.plan.title')}</Text>
        <View style={s.headerButton} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 64 }} keyboardShouldPersistTaps="handled">
          {!plan ? (
            <>
              <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.plan.describeHint')}</Text>
              <Textarea
                value={request}
                onChangeText={setRequest}
                placeholder={t('pipeline.plan.placeholder')}
                numberOfLines={6}
                style={{ minHeight: 130 }}
              />
              {failure && <Text style={[s.error, { color: tokens.destructive }]}>{failure}</Text>}
              <View style={s.footer}>
                <Pressable
                  onPress={() => router.replace({ pathname: '/(main)/pipeline/[id]/task/new', params: { id: pipeline.id } })}
                  style={s.secondaryButton}
                >
                  <Text style={[s.secondaryText, { color: tokens.foreground }]}>{t('pipeline.plan.manual')}</Text>
                </Pressable>
                <Pressable
                  onPress={() => void propose()}
                  disabled={!request.trim() || busy}
                  style={[s.primaryButton, { backgroundColor: tokens.primary, opacity: request.trim() && !busy ? 1 : 0.4 }]}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={tokens.primaryForeground} />
                  ) : (
                    <Text style={[s.primaryText, { color: tokens.primaryForeground }]}>{t('pipeline.plan.propose')}</Text>
                  )}
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.plan.reviewHint')}</Text>
              {plan.map((task, index) => (
                <View key={`${index}-${task.title}`} style={[s.card, { borderColor: tokens.border }]}>
                  <View style={s.cardTop}>
                    <Text style={[s.cardTitle, { color: tokens.foreground }]}>{task.title}</Text>
                    <Pressable onPress={() => setPlan(withoutTask(plan, index))} hitSlop={8} style={s.remove}>
                      <X size={16} color={tokens.mutedForeground} />
                    </Pressable>
                  </View>
                  <Text style={[s.cardBody, { color: tokens.mutedForeground }]} numberOfLines={5}>
                    {task.description}
                  </Text>
                  {task.dependsOn.length > 0 && (
                    <Text style={[s.cardMeta, { color: tokens.mutedForeground }]}>
                      {t('pipeline.plan.waitsFor', { tasks: task.dependsOn.map((dep) => plan[dep]?.title ?? '').join(', ') })}
                    </Text>
                  )}
                  {task.files.length > 0 && (
                    <Text style={[s.cardMeta, { color: tokens.mutedForeground, fontFamily: 'Menlo' }]} numberOfLines={2}>
                      {task.files.join(', ')}
                    </Text>
                  )}
                </View>
              ))}
              {failure && <Text style={[s.error, { color: tokens.destructive }]}>{failure}</Text>}
              <View style={s.footer}>
                <Pressable onPress={() => setPlan(null)} style={s.secondaryButton}>
                  <Text style={[s.secondaryText, { color: tokens.foreground }]}>{t('pipeline.plan.back')}</Text>
                </Pressable>
                <Pressable
                  onPress={() => void create()}
                  disabled={plan.length === 0 || busy}
                  style={[s.primaryButton, { backgroundColor: tokens.primary, opacity: plan.length > 0 && !busy ? 1 : 0.4 }]}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={tokens.primaryForeground} />
                  ) : (
                    <Text style={[s.primaryText, { color: tokens.primaryForeground }]}>
                      {t('pipeline.plan.create', { count: plan.length })}
                    </Text>
                  )}
                </Pressable>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 17 },
  error: { fontSize: 12 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10 },
  secondaryButton: { paddingHorizontal: 14, paddingVertical: 10 },
  secondaryText: { fontSize: 14, fontWeight: '500' },
  primaryButton: { minWidth: 120, alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  primaryText: { fontSize: 14, fontWeight: '600' },
  card: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 6 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: '600' },
  remove: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  cardBody: { fontSize: 12, lineHeight: 17 },
  cardMeta: { fontSize: 11 },
})
