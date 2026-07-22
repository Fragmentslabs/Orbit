import { useEffect, useState, useCallback } from 'react'
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator, TextInput } from 'react-native'
import { FileText, RefreshCw, X, MessageSquareText, Send } from 'lucide-react-native'
import type { PlanReview, PermissionMode } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'
import { useConnectionStore } from '~/stores/connection-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'

interface Props {
  sessionId: string
  review: PlanReview
}

const ALL_MODES: { id: PermissionMode; label: string }[] = [
  { id: 'ask', label: 'Perguntas' },
  { id: 'approve', label: 'Autonomia' },
  { id: 'full', label: 'Irrestrito' },
]

const MODE_LABEL: Record<PermissionMode, string> = {
  ask: 'Perguntar',
  approve: 'Autonomia',
  full: 'Irrestrito',
}

export function PlanReviewCard({ sessionId, review }: Props) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const acceptPlanReview = useSessionStore((s) => s.acceptPlanReview)
  const rejectPlanReview = useSessionStore((s) => s.rejectPlanReview)
  const reviewPlanReview = useSessionStore((s) => s.reviewPlanReview)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewText, setReviewText] = useState('')
  const currentMode: PermissionMode = 'ask'
  const otherModes = ALL_MODES.filter((m) => m.id !== currentMode)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { wsClient } = useConnectionStore.getState()
      const res = await wsClient.send({ type: 'plan:read-file', sessionId })
      if (res.ok && typeof res.data === 'string') {
        setContent(res.data)
      }
    } finally {
      setLoading(false)
    }
  }, [sessionId])

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
  }

  if (review.status === 'rejected') return null

  const isProposed = review.status === 'proposed'

  return (
    <>
      <View
        className="px-3 py-2"
        style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: hslToRgba(hsl(tokens.muted), 0.3),
        }}
      >
        <View className="flex-row items-center gap-2">
          <FileText size={16} color={tokens.primary} />
          <Text className="font-medium text-xs flex-shrink" style={{ color: tokens.foreground }}>
            {isProposed ? 'Plano de implementação proposto' : 'Implementando plano'}
          </Text>
          {checkboxCount > 0 && (
            <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
              {checkedCount}/{checkboxCount}
            </Text>
          )}
          <View className="flex-row items-center gap-1 ml-auto">
            <Pressable
              onPress={() => setDialogOpen(true)}
              className="px-2 py-1 rounded-md"
              style={{ backgroundColor: tokens.card }}
            >
              <Text className="text-xs font-medium" style={{ color: tokens.primary }}>Ver plano</Text>
            </Pressable>
            {isProposed ? (
              <>
                <Pressable
                  onPress={() => setReviewOpen(!reviewOpen)}
                  className="px-2 py-1 rounded-md flex-row items-center gap-1"
                  style={{ backgroundColor: tokens.card }}
                >
                  <MessageSquareText size={12} color={tokens.mutedForeground} />
                  <Text className="text-xs" style={{ color: tokens.mutedForeground }}>Revisar</Text>
                </Pressable>
                <Pressable
                  onPress={() => rejectPlanReview(sessionId)}
                  className="px-2 py-1 rounded-md"
                  style={{ backgroundColor: tokens.card }}
                >
                  <Text className="text-xs" style={{ color: tokens.mutedForeground }}>Rejeitar</Text>
                </Pressable>
                <Pressable
                  onPress={() => acceptPlanReview(sessionId, currentMode)}
                  className="px-2 py-1 rounded-md"
                  style={{ backgroundColor: tokens.primary }}
                >
                  <Text className="text-xs font-medium" style={{ color: '#fff' }}>
                    Aceitar ({MODE_LABEL[currentMode]})
                  </Text>
                </Pressable>
                {otherModes.length > 0 && (
                  <View className="flex-col gap-0.5">
                    {otherModes.slice(0, 1).map((m) => (
                      <Pressable
                        key={m.id}
                        onPress={() => acceptPlanReview(sessionId, m.id)}
                        className="px-1.5 py-0.5 rounded"
                        style={{ backgroundColor: tokens.card }}
                      >
                        <Text className="text-[10px]" style={{ color: tokens.mutedForeground }}>
                          {m.label}
                        </Text>
                      </Pressable>
                    ))}
                    <Pressable
                      onPress={() => acceptPlanReview(sessionId, currentMode, true)}
                      className="px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: tokens.card }}
                    >
                      <Text className="text-[10px]" style={{ color: tokens.mutedForeground }}>
                        Orquestração
                      </Text>
                    </Pressable>
                  </View>
                )}
              </>
            ) : (
              <Pressable onPress={load} disabled={loading} className="p-1">
                <RefreshCw size={14} color={tokens.mutedForeground} />
              </Pressable>
            )}
          </View>
        </View>
        {isProposed && reviewOpen && (
          <View
            className="flex-row items-center gap-2 mt-2 pt-2"
            style={{ borderTopWidth: 1, borderTopColor: tokens.border }}
          >
            <TextInput
              value={reviewText}
              onChangeText={setReviewText}
              placeholder="Escreva seu feedback para revisar o plano..."
              placeholderTextColor={tokens.mutedForeground}
              style={{
                flex: 1,
                height: 32,
                fontSize: 12,
                color: tokens.foreground,
                backgroundColor: tokens.card,
                borderRadius: 6,
                paddingHorizontal: 8,
              }}
              onSubmitEditing={handleSubmitReview}
              returnKeyType="send"
            />
            <Pressable
              onPress={handleSubmitReview}
              disabled={!reviewText.trim()}
              className="px-2 py-1.5 rounded-md"
              style={{ backgroundColor: tokens.primary, opacity: reviewText.trim() ? 1 : 0.5 }}
            >
              <Send size={14} color="#fff" />
            </Pressable>
          </View>
        )}
      </View>

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
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </View>
      <View
        style={{
          maxHeight: '85%',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: 16,
          backgroundColor: tokens.background,
        }}
      >
        <View className="flex-row items-center justify-between mb-4">
          <View className="flex-row items-center gap-2">
            <Text className="text-base font-semibold" style={{ color: tokens.foreground }}>PLAN.md</Text>
            {checkboxCount > 0 && (
              <Text className="text-sm" style={{ color: tokens.mutedForeground }}>
                ({checkedCount}/{checkboxCount} concluídas)
              </Text>
            )}
          </View>
          <Pressable onPress={onClose} className="p-1">
            <X size={20} color={tokens.mutedForeground} />
          </Pressable>
        </View>

        <ScrollView className="flex-1 mb-4">
          {loading ? (
            <ActivityIndicator size="small" color={tokens.primary} />
          ) : content ? (
            <Text className="text-sm" style={{ color: tokens.foreground }} selectable>
              {content}
            </Text>
          ) : (
            <Text className="text-sm" style={{ color: tokens.mutedForeground }}>
              PLAN.md não encontrado.
            </Text>
          )}
        </ScrollView>

        <Pressable
          onPress={onReload}
          disabled={loading}
          className="flex-row items-center justify-center gap-2 py-2 rounded-lg"
          style={{ backgroundColor: tokens.muted }}
        >
          <RefreshCw size={14} color={tokens.foreground} />
          <Text className="text-sm font-medium" style={{ color: tokens.foreground }}>Recarregar</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

const hsl = (v: string) => v.replace(/hsla?\(|\)/g, '').replace(/,/g, '')
