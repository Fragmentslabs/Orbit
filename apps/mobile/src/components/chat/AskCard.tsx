import { useState } from 'react'
import { View, Text, Pressable, TextInput, Platform } from 'react-native'
import { ShieldAlert, HelpCircle, TriangleAlert, User, ChevronDown, ChevronUp } from 'lucide-react-native'
import type { PendingAsk } from '~/stores/chat-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface AskCardProps {
  ask: PendingAsk
  onReply: (value: unknown) => void
}

function btnMuted(tokens: Record<string, string>) {
  return {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.muted,
    alignItems: 'center' as const,
    flex: 1,
  }
}

function btnPrimary(tokens: Record<string, string>) {
  return {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.primary,
    backgroundColor: tokens.primary,
    alignItems: 'center' as const,
    flex: 1,
  }
}

export function AskCard({ ask, onReply }: AskCardProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [submitted, setSubmitted] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [questionIndex, setQuestionIndex] = useState(0)
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({})
  const [textAnswers, setTextAnswers] = useState<Record<string, string>>({})

  const reply = (value: unknown) => {
    if (submitted) return
    setSubmitted(true)
    onReply(value)
  }

  const cardBg = {
    marginHorizontal: 16,
    marginVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.card,
    padding: 12,
  }

  // ─── Permissions ──────────────────────────────────────────────────────

  if (ask.kind === 'permission' && ask.claim) {
    const critical = ask.claim.critical
    return (
      <View style={cardBg}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          {critical ? (
            <TriangleAlert size={16} color="#ef4444" />
          ) : (
            <ShieldAlert size={16} color={tokens.mutedForeground} />
          )}
          <Text
            style={{
              fontSize: 11,
              fontWeight: '700',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: tokens.foreground,
            }}
          >
            Permissão necessária
          </Text>
          {ask.origin && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
              <User size={11} color={tokens.mutedForeground} />
              <Text style={{ fontSize: 10, color: tokens.mutedForeground }}>
                {ask.origin.workerTitle}
              </Text>
            </View>
          )}
        </View>

        {/* Claim title */}
        <Text
          style={{
            fontSize: 12,
            fontWeight: '600',
            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
            color: tokens.foreground,
            marginBottom: ask.claim.detail ? 4 : 10,
          }}
        >
          {ask.claim.title}
        </Text>

        {/* Claim detail */}
        {ask.claim.detail && (
          <Text
            style={{
              fontSize: 11,
              color: critical ? '#ef4444' : tokens.mutedForeground,
              lineHeight: 16,
              marginBottom: 10,
            }}
          >
            {critical ? 'Ação crítica: ' : ''}{ask.claim.detail}
          </Text>
        )}

        {/* Actions row: Negar | Uma vez */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: showMore ? 6 : 0 }}>
          <Pressable
            onPress={() => reply('deny')}
            disabled={submitted}
            style={{ ...btnMuted(tokens), opacity: submitted ? 0.4 : 1 }}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.foreground }}>Negar</Text>
          </Pressable>
          <Pressable
            onPress={() => reply('allow')}
            disabled={submitted}
            style={{ ...btnPrimary(tokens), opacity: submitted ? 0.4 : 1 }}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.primaryForeground }}>
              Uma vez
            </Text>
          </Pressable>
        </View>

        {/* Accordion for more options */}
        <Pressable
          onPress={() => setShowMore((v) => !v)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            paddingVertical: 6,
          }}
        >
          <Text style={{ fontSize: 11, color: tokens.mutedForeground }}>
            {showMore ? 'Menos opções' : 'Mais opções'}
          </Text>
          {showMore ? (
            <ChevronUp size={12} color={tokens.mutedForeground} />
          ) : (
            <ChevronDown size={12} color={tokens.mutedForeground} />
          )}
        </Pressable>

        {showMore && (
          <View style={{ gap: 6 }}>
            <Pressable
              onPress={() => reply('always_chat')}
              disabled={submitted}
              style={{ ...btnMuted(tokens), opacity: submitted ? 0.4 : 1 }}
            >
              <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.foreground }}>
                Sempre neste chat
              </Text>
            </Pressable>
            <Pressable
              onPress={() => reply('always')}
              disabled={submitted}
              style={{ ...btnMuted(tokens), opacity: submitted ? 0.4 : 1 }}
            >
              <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.foreground }}>
                Sempre
              </Text>
            </Pressable>
          </View>
        )}
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
      <View style={cardBg}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <HelpCircle size={16} color={tokens.primary} />
          <Text
            style={{
              fontSize: 11,
              fontWeight: '700',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: tokens.foreground,
            }}
          >
            Pergunta {questions.length > 1 ? `${questionIndex + 1}/${questions.length}` : ''}
          </Text>
          {ask.origin && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
              <User size={11} color={tokens.mutedForeground} />
              <Text style={{ fontSize: 10, color: tokens.mutedForeground }}>
                {ask.origin.workerTitle}
              </Text>
            </View>
          )}
        </View>

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
                    paddingVertical: 10,
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
          placeholder="Outra resposta…"
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
            minHeight: 40,
            marginBottom: 10,
            textAlignVertical: 'top',
          }}
        />

        {/* Action buttons: Dispensar | Responder */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={() => reply({ rejected: true })}
            disabled={submitted}
            style={{ ...btnMuted(tokens), opacity: submitted ? 0.4 : 1 }}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.mutedForeground }}>
              Dispensar
            </Text>
          </Pressable>
          <Pressable
            onPress={submitAnswers}
            disabled={submitted || !allAnswered}
            style={{ ...btnPrimary(tokens), opacity: submitted || !allAnswered ? 0.4 : 1 }}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.primaryForeground }}>
              Responder
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return null
}
