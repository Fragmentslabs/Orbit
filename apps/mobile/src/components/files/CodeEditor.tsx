import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import type { NativeSyntheticEvent, TextInputSelectionChangeEventData } from 'react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import {
  autoIndentNewline,
  insertChar,
  insertPair,
  insertTab,
  lineCount,
  longestLine,
  outdent,
  type EditResult,
  type Selection,
} from '~/lib/files'
import { CODE_CHAR_WIDTH, CODE_FONT_SIZE, CODE_LINE_HEIGHT } from './CodeViewer'

const MONO = { fontFamily: 'Menlo' as const }
const MAX_WIDTH_CHARS = 4000

export interface CodeEditorHandle {
  focus: () => void
  blur: () => void
}

interface Props {
  value: string
  onChange: (next: string) => void
  autoFocus?: boolean
}

/**
 * Plain monospace editor on a native multiline TextInput (works the same on iOS and
 * Android, keeps the OS keyboard, selection and dictation). No-wrap: the input is as wide
 * as the longest line inside a horizontal scroll so the gutter numbers stay aligned.
 * Syntax colors are viewer-only — painting inside a TextInput is unreliable on Android.
 */
export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor({ value, onChange, autoFocus }, ref) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const input = useRef<TextInput>(null)
  const sel = useRef<Selection>({ start: 0, end: 0 })
  const prev = useRef(value)
  const [forced, setForced] = useState<Selection | undefined>(undefined)
  const { t } = useTranslation()

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), blur: () => input.current?.blur() }))

  const count = lineCount(value)
  const gutter = String(count).length * CODE_CHAR_WIDTH + 16
  const inputWidth = Math.max(Math.min(longestLine(value), MAX_WIDTH_CHARS) + 6, 40) * CODE_CHAR_WIDTH
  const numbers = useMemo(() => Array.from({ length: count }, (_, i) => i + 1).join('\n'), [count])

  const apply = useCallback(
    (res: EditResult) => {
      prev.current = res.text
      sel.current = res.selection
      onChange(res.text)
      setForced(res.selection)
    },
    [onChange],
  )

  const onChangeText = (next: string) => {
    const before = prev.current
    const caret = Math.min(sel.current.start + (next.length - before.length), next.length)
    const indented = autoIndentNewline(before, next, caret)
    if (indented) {
      apply(indented)
      return
    }
    prev.current = next
    onChange(next)
  }

  const onSelectionChange = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    sel.current = e.nativeEvent.selection
    // Release the programmatic selection once the native side has caught up, so typing is free again.
    if (forced && sel.current.start === forced.start && sel.current.end === forced.end) setForced(undefined)
  }

  const keys: { label: string; run: () => void }[] = [
    { label: t('filesBrowser.keys.tab'), run: () => apply(insertTab(value, sel.current)) },
    { label: '⇤', run: () => apply(outdent(value, sel.current)) },
    ...['(', ')', '[', ']', '{', '}', '"', "'", '`', ';', ':', '=', '<', '>', '/', '_', '-', '+', '*', '&', '|', '\\', '#', '$'].map((ch) => ({
      label: ch,
      run: () => apply(['(', '[', '{', '"', "'", '`'].includes(ch) ? insertPair(value, sel.current, ch) : insertChar(value, sel.current, ch)),
    })),
  ]

  return (
    <View style={{ flex: 1 }}>
      <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="always">
        <ScrollView style={{ width: gutter + inputWidth + 24 }} keyboardShouldPersistTaps="always" keyboardDismissMode="interactive">
          <View style={{ flexDirection: 'row', paddingVertical: 8 }}>
            <Text
              style={[MONO, { width: gutter, textAlign: 'right', paddingRight: 10, fontSize: CODE_FONT_SIZE - 1, lineHeight: CODE_LINE_HEIGHT, color: tokens.mutedForeground, opacity: 0.6 }]}
            >
              {numbers}
            </Text>
            <TextInput
              ref={input}
              value={value}
              onChangeText={onChangeText}
              onSelectionChange={onSelectionChange}
              selection={forced}
              multiline
              scrollEnabled={false}
              autoFocus={autoFocus}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              smartInsertDelete={false}
              keyboardType="default"
              textAlignVertical="top"
              style={[MONO, { width: inputWidth, padding: 0, margin: 0, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT, color: tokens.foreground }]}
              selectionColor={tokens.primary}
            />
          </View>
        </ScrollView>
      </ScrollView>

      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, borderTopWidth: 1, borderTopColor: tokens.border, backgroundColor: tokens.card }}
        contentContainerStyle={{ paddingHorizontal: 6, paddingVertical: 6, gap: 6 }}
      >
        {keys.map((k) => (
          <Pressable
            key={k.label}
            onPress={k.run}
            style={({ pressed }) => ({
              minWidth: 40,
              height: 38,
              paddingHorizontal: 10,
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? tokens.accent : tokens.muted,
            })}
          >
            <Text style={[MONO, { fontSize: 15, color: tokens.foreground }]}>{k.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
})
