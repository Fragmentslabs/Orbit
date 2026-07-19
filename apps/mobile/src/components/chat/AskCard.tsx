import { useState } from 'react'
import { View, Text, Pressable, TextInput, Platform } from 'react-native'
import { ShieldAlert, HelpCircle, TriangleAlert, User } from 'lucide-react-native'
import type { PendingAsk } from '~/stores/chat-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface AskCardProps {
  ask: PendingAsk
  onReply: (value: unknown) => void
}

export function AskCard({ ask, onReply }: AskCardProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [submitted, setSubmitted] = useState(false)
  const [questionIndex, setQuestionIndex] = useState(0)
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({})
  const [textAnswers, setTextAnswers] = useState<Record<string, string>>({})
  const isPermission = ask.kind === 'permission'

  const reply = (value: unknown) => {
    if (submitted) return
    setSubmitted(true)
    onReply(value)
  }

  // ─── Permissions ──────────────────────────────────────────────────────

  if (isPermission && ask.claim) {
    const critical = ask.claim.critical
    return (
      <View
        style={{
          marginHorizontal: 16,
          marginVertical: 8,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: critical ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)',
          backgroundColor: critical ? 'rgba(239,68,68,0.05)' : 'rgba(245,158,11,0.05)',
          padding: 12,
        }}
      >
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          {critical ? (
            <TriangleAlert size={16} color="#ef4444" />
          ) : (
            <ShieldAlert size={16} color="#f59e0b" />
          )}
          <Text
            style={{
              fontSize: 11,
              fontWeight: '700',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: critical ? '#ef4444' : '#f59e0b',
            }}
          >
            {critical ? 'Operação crítica' : 'Permissão necessária'}
          </Text>
        </View>

        {/* Origin badge */}
        {ask.origin && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              marginBottom: 6,
            }}
          >
            <User size={11} color={tokens.mutedForeground} />
            <Text style={{ fontSize: 10, color: tokens.mutedForeground }}>
              worker: {ask.origin.workerTitle}
            </Text>
          </View>
        )}

        {/* Claim */}
        <Text
          style={{
            fontSize: 12,
            fontWeight: '600',
            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
            color: tokens.foreground,
            marginBottom: ask.claim.detail ? 4 : 8,
          }}
        >
          {ask.claim.title}
        </Text>
        {ask.claim.detail && (
          <Text
            style={{
              fontSize: 11,
              color: tokens.mutedForeground,
              lineHeight: 16,
              marginBottom: 8,
            }}
          >
            {ask.claim.detail}
          </Text>
        )}

        {/* Actions */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={() => reply('deny')}
            disabled={submitted}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: critical ? 'rgba(239,68,68,0.3)' : 'rgba(239,68,68,0.2)',
              backgroundColor: critical ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.06)',
              alignItems: 'center',
              opacity: submitted ? 0.4 : 1,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: '#ef4444' }}>Negar</Text>
          </Pressable>

          <Pressable
            onPress={() => reply('allow')}
            disabled={submitted}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: 'rgba(34,197,94,0.3)',
              backgroundColor: 'rgba(34,197,94,0.1)',
              alignItems: 'center',
              opacity: submitted ? 0.4 : 1,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: '#22c55e' }}>Uma vez</Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
          <Pressable
            onPress={() => reply('always_chat')}
            disabled={submitted}
            style={{
              flex: 1,
              paddingVertical: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.muted,
              alignItems: 'center',
              opacity: submitted ? 0.4 : 1,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: '500', color: tokens.mutedForeground }}>
              Sempre neste chat
            </Text>
          </Pressable>
          <Pressable
            onPress={() => reply('always')}
            disabled={submitted}
            style={{
              flex: 1,
              paddingVertical: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.muted,
              alignItems: 'center',
              opacity: submitted ? 0.4 : 1,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: '500', color: tokens.mutedForeground }}>
              Sempre
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }

  // ─── Questions ────────────────────────────────────────────────────────

  const questions = ask.questions
  if (questions && questions.length > 0) {
    const q = questions[questionIndex]
    const selected = selectedOptions[q.id] ?? []
    const textAnswer = textAnswers[q.id] ?? ''

    const toggleOption = (opt: string) => {
      setSelectedOptions((prev) => {
        const current = prev[q.id] ?? []
        if (q.multi) {
          return {
            ...prev,
            [q.id]: current.includes(opt)
              ? current.filter((o) => o !== opt)
              : [...current, opt],
          }
        }
        return { ...prev, [q.id]: [opt] }
      })
    }

    const allAnswered = questions.every((qq) => {
      const sel = selectedOptions[qq.id]
      return (sel && sel.length > 0) || (textAnswers[qq.id]?.trim() ?? '') !== ''
    })

    const submitAnswers = () => {
      const answers = questions.map((qq) => {
        const sel = selectedOptions[qq.id] ?? []
        const txt = textAnswers[qq.id] ?? ''
        return {
          id: qq.id,
          text: qq.text,
          selected: sel.length > 0 ? sel : undefined,
          answer: txt.trim() || undefined,
        }
      })
      reply({ answers })
    }

    return (
      <View
        style={{
          marginHorizontal: 16,
          marginVertical: 8,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: 'rgba(99,102,241,0.3)',
          backgroundColor: 'rgba(99,102,241,0.05)',
          padding: 12,
        }}
      >
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <HelpCircle size={16} color="#818cf8" />
          <Text
            style={{
              fontSize: 11,
              fontWeight: '700',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: '#818cf8',
            }}
          >
            Pergunta {questions.length > 1 ? `${questionIndex + 1}/${questions.length}` : ''}
          </Text>
        </View>

        {/* Origin badge */}
        {ask.origin && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 }}>
            <User size={11} color={tokens.mutedForeground} />
            <Text style={{ fontSize: 10, color: tokens.mutedForeground }}>
              worker: {ask.origin.workerTitle}
            </Text>
          </View>
        )}

        {/* Navigation for multi-question */}
        {questions.length > 1 && (
          <View style={{ flexDirection: 'row', gap: 4, marginBottom: 8 }}>
            <Pressable
              onPress={() => setQuestionIndex((i) => Math.max(0, i - 1))}
              disabled={questionIndex === 0}
              style={{
                paddingVertical: 4,
                paddingHorizontal: 10,
                borderRadius: 6,
                backgroundColor: tokens.muted,
                opacity: questionIndex === 0 ? 0.4 : 1,
              }}
            >
              <Text style={{ fontSize: 11, color: tokens.foreground }}>←</Text>
            </Pressable>
            <Pressable
              onPress={() => setQuestionIndex((i) => Math.min(questions.length - 1, i + 1))}
              disabled={questionIndex === questions.length - 1}
              style={{
                paddingVertical: 4,
                paddingHorizontal: 10,
                borderRadius: 6,
                backgroundColor: tokens.muted,
                opacity: questionIndex === questions.length - 1 ? 0.4 : 1,
              }}
            >
              <Text style={{ fontSize: 11, color: tokens.foreground }}>→</Text>
            </Pressable>
          </View>
        )}

        {/* Question text */}
        <Text
          style={{
            fontSize: 13,
            color: tokens.foreground,
            lineHeight: 18,
            marginBottom: 10,
          }}
        >
          {q.text}
        </Text>

        {/* Options */}
        {q.options && q.options.length > 0 && (
          <View style={{ gap: 4, marginBottom: 10 }}>
            {q.options.map((opt) => {
              const isSelected = selected.includes(opt)
              return (
                <Pressable
                  key={opt}
                  onPress={() => toggleOption(opt)}
                  disabled={submitted}
                  style={{
                    paddingVertical: 8,
                    paddingHorizontal: 12,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: isSelected ? tokens.primary : tokens.border,
                    backgroundColor: isSelected ? tokens.primary + '18' : 'transparent',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      color: isSelected ? tokens.primary : tokens.foreground,
                      fontWeight: isSelected ? '600' : '400',
                    }}
                  >
                    {opt}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        )}

        {/* Free text input */}
        <TextInput
          value={textAnswer}
          onChangeText={(v) => setTextAnswers((prev) => ({ ...prev, [q.id]: v }))}
          placeholder="Digite sua resposta..."
          placeholderTextColor={tokens.mutedForeground}
          multiline
          editable={!submitted}
          style={{
            color: tokens.foreground,
            fontSize: 12,
            borderWidth: 1,
            borderColor: tokens.border,
            borderRadius: 8,
            padding: 10,
            minHeight: 60,
            marginBottom: 10,
            textAlignVertical: 'top',
          }}
        />

        {/* Action buttons */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={() => reply({ rejected: true })}
            disabled={submitted}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.muted,
              alignItems: 'center',
              opacity: submitted ? 0.4 : 1,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.mutedForeground }}>
              Dispensar
            </Text>
          </Pressable>
          <Pressable
            onPress={submitAnswers}
            disabled={submitted || !allAnswered}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: 'rgba(99,102,241,0.3)',
              backgroundColor: 'rgba(99,102,241,0.1)',
              alignItems: 'center',
              opacity: submitted || !allAnswered ? 0.4 : 1,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: '#818cf8' }}>
              Responder
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return null
}
