import { useEffect, useState, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  ActivityIndicator,
  TextInput,
  StyleSheet,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  FileText,
  RefreshCw,
  X,
  MessageSquareText,
  Send,
  ChevronDown,
  Workflow,
  ShieldCheck,
} from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { PlanReview, PermissionMode } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'
import { usePermissionPrefs } from '~/stores/permission-prefs'
import { useConnectionStore } from '~/stores/connection-store'
import { getThemeTokens, withAlpha, type ThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { AssistantMarkdown } from '~/components/chat/AssistantMarkdown'

interface Props {
  sessionId: string
  review: PlanReview
}

/** Uma linha de texto — mesma altura do botão de enviar ao lado. */
const REVIEW_MIN_HEIGHT = 40
const REVIEW_MAX_HEIGHT = 120

function useAllModes(): { id: PermissionMode; label: string }[] {
  const { t } = useTranslation()
  return [
    { id: 'ask', label: t('planReview.modes.askLabel') },
    { id: 'approve', label: t('planReview.modes.approve') },
    { id: 'full', label: t('planReview.modes.full') },
  ]
}

function useModeLabel(): Record<PermissionMode, string> {
  const { t } = useTranslation()
  return {
    ask: t('planReview.modes.askLabel'),
    approve: t('planReview.modes.approve'),
    full: t('planReview.modes.full'),
  }
}

/** Botão secundário compacto — divide a largura por igual na linha de ações. */
function GhostButton({
  label,
  icon,
  onPress,
  active,
  tokens,
}: {
  label: string
  icon?: React.ReactNode
  onPress: () => void
  active?: boolean
  tokens: ThemeTokens
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.ghost,
        {
          backgroundColor: active ? withAlpha(tokens.primary, 0.15) : tokens.card,
          borderColor: active ? tokens.primary : tokens.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {icon}
      <Text
        style={[s.ghostLabel, { color: active ? tokens.primary : tokens.mutedForeground }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  )
}

export function PlanReviewCard({ sessionId, review }: Props) {
  const { t } = useTranslation()
  const ALL_MODES = useAllModes()
  const MODE_LABEL = useModeLabel()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const acceptPlanReview = useSessionStore((s) => s.acceptPlanReview)
  const rejectPlanReview = useSessionStore((s) => s.rejectPlanReview)
  const reviewPlanReview = useSessionStore((s) => s.reviewPlanReview)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [modesOpen, setModesOpen] = useState(false)
  // Conteúdo do próprio evento de plano: o PLAN.md em disco é opcional, então
  // sem esse fallback o "ver plano" abria vazio na maioria das sessões.
  const [content, setContent] = useState<string | null>(review.content ?? null)
  const [loading, setLoading] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewText, setReviewText] = useState('')
  // Começa com uma linha (mesma altura do botão de enviar) e só cresce quando
  // o texto passa da linha ou o Enter quebra linha.
  const [reviewHeight, setReviewHeight] = useState(REVIEW_MIN_HEIGHT)
  // Sugere o modo de permissão selecionado agora (igual ao desktop); num
  // plano já aceito, o modo com que ele foi aceito.
  const activeMode = usePermissionPrefs((s) => s.mode)
  const currentMode: PermissionMode = review.permissionMode ?? activeMode
  const otherModes = ALL_MODES.filter((m) => m.id !== currentMode)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { wsClient } = useConnectionStore.getState()
      const res = await wsClient.send({ type: 'plan:read-file', sessionId })
      if (res.ok && typeof res.data === 'string' && res.data.trim()) {
        setContent(res.data)
      }
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (review.content) setContent(review.content)
  }, [review.content])

  useEffect(() => { load() }, [review.status])

  const checkboxCount = content
    ? [...content.matchAll(/\[(\s|x)\]/gi)].length
    : 0
  const checkedCount = content
    ? [...content.matchAll(/\[x\]/gi)].length
    : 0

  function handleSubmitReview() {
    const text = reviewText.trim()
    if (!text) return
    reviewPlanReview(sessionId, text)
    setReviewOpen(false)
    setReviewText('')
    setReviewHeight(REVIEW_MIN_HEIGHT)
  }

  function handleAccept(mode: PermissionMode, orchestration?: boolean) {
    setModesOpen(false)
    acceptPlanReview(sessionId, mode, orchestration)
  }

  if (review.status === 'rejected') return null

  const isProposed = review.status === 'proposed'

  return (
    <>
      <View
        style={[
          s.card,
          { borderColor: tokens.border, backgroundColor: withAlpha(tokens.muted, 0.35) },
        ]}
      >
        <View style={s.header}>
          <FileText size={15} color={tokens.primary} />
          <Text style={[s.title, { color: tokens.foreground }]} numberOfLines={2}>
            {isProposed ? t('planReview.proposedTitle') : t('planReview.implementingTitle')}
          </Text>
          {checkboxCount > 0 && (
            <Text style={[s.counter, { color: tokens.mutedForeground }]}>
              {checkedCount}/{checkboxCount}
            </Text>
          )}
          {!isProposed && (
            <Pressable onPress={load} disabled={loading} hitSlop={8} style={{ padding: 2 }}>
              {loading ? (
                <ActivityIndicator size="small" color={tokens.mutedForeground} />
              ) : (
                <RefreshCw size={14} color={tokens.mutedForeground} />
              )}
            </Pressable>
          )}
        </View>

        <View style={s.actionsRow}>
          <GhostButton
            label={t('planReview.viewPlan')}
            icon={<FileText size={13} color={tokens.mutedForeground} />}
            onPress={() => setDialogOpen(true)}
            tokens={tokens}
          />
          {isProposed && (
            <>
              <GhostButton
                label={t('planReview.review')}
                icon={
                  <MessageSquareText
                    size={13}
                    color={reviewOpen ? tokens.primary : tokens.mutedForeground}
                  />
                }
                onPress={() => setReviewOpen((open) => !open)}
                active={reviewOpen}
                tokens={tokens}
              />
              <GhostButton
                label={t('planReview.reject')}
                onPress={() => rejectPlanReview(sessionId)}
                tokens={tokens}
              />
            </>
          )}
        </View>

        {isProposed && (
          <View style={s.acceptRow}>
            <Pressable
              onPress={() => handleAccept(currentMode)}
              style={({ pressed }) => [
                s.accept,
                { backgroundColor: tokens.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[s.acceptLabel, { color: tokens.primaryForeground }]} numberOfLines={1}>
                {t('planReview.accept', { mode: MODE_LABEL[currentMode] })}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setModesOpen(true)}
              accessibilityLabel={t('planReview.moreOptions')}
              style={({ pressed }) => [
                s.acceptMore,
                {
                  backgroundColor: tokens.primary,
                  borderLeftColor: withAlpha(tokens.primaryForeground, 0.25),
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <ChevronDown size={16} color={tokens.primaryForeground} />
            </Pressable>
          </View>
        )}

        {isProposed && reviewOpen && (
          <View style={[s.reviewBox, { borderTopColor: tokens.border }]}>
            <TextInput
              value={reviewText}
              onChangeText={setReviewText}
              placeholder={t('planReview.reviewPlaceholder')}
              placeholderTextColor={tokens.mutedForeground}
              multiline
              // Enter quebra linha — o envio é só pelo botão ao lado.
              submitBehavior="newline"
              onContentSizeChange={(e) =>
                setReviewHeight(
                  Math.min(
                    Math.max(REVIEW_MIN_HEIGHT, Math.ceil(e.nativeEvent.contentSize.height)),
                    REVIEW_MAX_HEIGHT,
                  ),
                )
              }
              style={[
                s.reviewInput,
                {
                  height: reviewHeight,
                  color: tokens.foreground,
                  backgroundColor: tokens.card,
                  borderColor: tokens.border,
                },
              ]}
            />
            <Pressable
              onPress={handleSubmitReview}
              disabled={!reviewText.trim()}
              style={[
                s.send,
                { backgroundColor: tokens.primary, opacity: reviewText.trim() ? 1 : 0.4 },
              ]}
            >
              <Send size={16} color={tokens.primaryForeground} />
            </Pressable>
          </View>
        )}
      </View>

      <ModesSheet
        visible={modesOpen}
        onClose={() => setModesOpen(false)}
        modes={otherModes}
        onAccept={handleAccept}
        currentMode={currentMode}
      />

      <PlanDialog
        visible={dialogOpen}
        onClose={() => setDialogOpen(false)}
        content={content}
        loading={loading}
        onReload={load}
        checkboxCount={checkboxCount}
        checkedCount={checkedCount}
      />
    </>
  )
}

/** Opções extras de aceite — em bottom sheet, que na tela estreita cabe melhor
 *  que o dropdown do desktop (antes essas ações vazavam para fora do card). */
function ModesSheet({
  visible,
  onClose,
  modes,
  onAccept,
  currentMode,
}: {
  visible: boolean
  onClose: () => void
  modes: { id: PermissionMode; label: string }[]
  onAccept: (mode: PermissionMode, orchestration?: boolean) => void
  currentMode: PermissionMode
}) {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View
          style={[
            s.sheet,
            {
              paddingBottom: insets.bottom + 12,
              backgroundColor: tokens.background,
              borderColor: tokens.border,
            },
          ]}
        >
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />
          <Text style={[s.sheetTitle, { color: tokens.foreground }]}>
            {t('planReview.moreOptions')}
          </Text>
          {modes.map((m) => (
            <Pressable
              key={m.id}
              onPress={() => onAccept(m.id)}
              style={({ pressed }) => [
                s.sheetRow,
                { backgroundColor: pressed ? tokens.muted : 'transparent' },
              ]}
            >
              <ShieldCheck size={16} color={tokens.mutedForeground} />
              <Text style={[s.sheetRowLabel, { color: tokens.foreground }]} numberOfLines={1}>
                {t('planReview.accept', { mode: m.label })}
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => onAccept(currentMode, true)}
            style={({ pressed }) => [
              s.sheetRow,
              { backgroundColor: pressed ? tokens.muted : 'transparent' },
            ]}
          >
            <Workflow size={16} color={tokens.mutedForeground} />
            <Text style={[s.sheetRowLabel, { color: tokens.foreground }]} numberOfLines={1}>
              {t('planReview.acceptOrchestration')}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

function PlanDialog({
  visible,
  onClose,
  content,
  loading,
  onReload,
  checkboxCount,
  checkedCount,
}: {
  visible: boolean
  onClose: () => void
  content: string | null
  loading: boolean
  onReload: () => void
  checkboxCount: number
  checkedCount: number
}) {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View
          style={[
            s.sheet,
            s.planSheet,
            {
              paddingBottom: insets.bottom + 12,
              backgroundColor: tokens.background,
              borderColor: tokens.border,
            },
          ]}
        >
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />
          <View style={s.planHeader}>
            <Text style={[s.sheetTitle, { color: tokens.foreground, marginBottom: 0 }]}>
              PLAN.md
            </Text>
            {checkboxCount > 0 && (
              <Text style={[s.counter, { color: tokens.mutedForeground }]}>
                {t('planReview.completedCount', { checked: checkedCount, total: checkboxCount })}
              </Text>
            )}
            <Pressable onPress={onClose} hitSlop={8} style={{ marginLeft: 'auto', padding: 4 }}>
              <X size={20} color={tokens.mutedForeground} />
            </Pressable>
          </View>

          {/* flexShrink em vez de flex:1: a folha se ajusta a planos curtos e
              para de crescer no maxHeight — com flex:1 o scroll ficava com
              altura zero e o markdown não aparecia. */}
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ paddingBottom: 12 }}
            showsVerticalScrollIndicator={false}
          >
            {content ? (
              <AssistantMarkdown text={content} size={13} />
            ) : loading ? (
              <ActivityIndicator size="small" color={tokens.primary} style={{ marginVertical: 24 }} />
            ) : (
              <Text style={[s.empty, { color: tokens.mutedForeground }]}>
                {t('planReview.notFound')}
              </Text>
            )}
          </ScrollView>

          <Pressable
            onPress={onReload}
            disabled={loading}
            style={[s.reload, { backgroundColor: tokens.muted }]}
          >
            <RefreshCw size={14} color={tokens.foreground} />
            <Text style={[s.reloadLabel, { color: tokens.foreground }]}>
              {t('planReview.reload')}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // flex + numberOfLines: sem isso o título era espremido pelos botões e
  // quebrava letra a letra, esticando o card por meia tela.
  title: { flex: 1, fontSize: 12, fontWeight: '500' },
  counter: { fontSize: 11 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  ghost: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  ghostLabel: { flexShrink: 1, fontSize: 12, fontWeight: '500' },
  acceptRow: { flexDirection: 'row', alignItems: 'stretch' },
  accept: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderTopLeftRadius: 8,
    borderBottomLeftRadius: 8,
  },
  acceptLabel: { fontSize: 13, fontWeight: '600' },
  acceptMore: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderLeftWidth: 1,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
  },
  reviewBox: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingTop: 8, borderTopWidth: 1 },
  reviewInput: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  send: { width: REVIEW_MIN_HEIGHT, height: REVIEW_MIN_HEIGHT, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },

  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  planSheet: { maxHeight: '85%' },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 12 },
  sheetTitle: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 14, borderRadius: 10 },
  sheetRowLabel: { flex: 1, fontSize: 14 },
  planHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  empty: { fontSize: 13, paddingVertical: 24 },
  reload: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 8,
  },
  reloadLabel: { fontSize: 13, fontWeight: '500' },
})
