import { memo, useCallback, useMemo, useState } from 'react'
import { FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { darkSyntaxPalette, highlightCode, lightSyntaxPalette } from '~/lib/syntax-highlight'
import { getThemeTokens } from '~/lib/theme-tokens'
import { languageOfPath } from '~/lib/git-api'
import { buildDiffItems, parsePatch, type DiffFile, type DiffItem, type DiffLine } from '~/lib/unified-diff'
import { useThemeStore } from '~/stores/theme-store'

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })
const CHAR_W = 6.7
const GUTTER = 36
const ADD_BG = 'rgba(16,185,129,0.14)'
const DEL_BG = 'rgba(239,68,68,0.14)'

/** One chunk of hunk lines: the rows share one horizontal scroller so long lines scroll together. */
const Chunk = memo(function Chunk({ file, lines, dark }: { file: DiffFile; lines: DiffLine[]; dark: boolean }) {
  const tokens = getThemeTokens(dark ? 'dark' : 'light')
  const palette = dark ? darkSyntaxPalette : lightSyntaxPalette
  const lang = languageOfPath(file.path)
  const width = useMemo(
    () => GUTTER * 2 + 16 + Math.max(...lines.map((l) => l.text.length), 1) * CHAR_W + 16,
    [lines],
  )
  const rows = useMemo(
    () => lines.map((line) => ({ line, tokens: line.text ? highlightCode(line.text, lang, palette) : [] })),
    [lines, lang, palette],
  )
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
      <View style={{ minWidth: width }}>
        {rows.map(({ line, tokens: toks }, i) => (
          <View
            key={i}
            style={[s.row, line.kind === 'add' && { backgroundColor: ADD_BG }, line.kind === 'del' && { backgroundColor: DEL_BG }]}
          >
            <Text style={[s.no, { color: tokens.mutedForeground }]}>{line.oldNo ?? ''}</Text>
            <Text style={[s.no, { color: tokens.mutedForeground }]}>{line.newNo ?? ''}</Text>
            <Text style={[s.sign, { color: line.kind === 'add' ? '#10b981' : line.kind === 'del' ? '#ef4444' : tokens.mutedForeground }]}>
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
            </Text>
            <Text style={[s.code, { color: palette.foreground }]}>
              {toks.length ? toks.map((tk, j) => <Text key={j} style={{ color: tk.color }}>{tk.text}</Text>) : ' '}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  )
})

/**
 * Syntax-colored unified diff: a header per file (tap to collapse), hunks below it, +/- lines on a
 * green/red background and horizontal scroll for long lines. Rendered as a virtualized list.
 */
export function DiffView({
  patch,
  collapsible = true,
  header,
  footer,
}: {
  patch: string
  /** Hide the per-file header (a screen that is already about one file). */
  collapsible?: boolean
  header?: React.ReactElement
  footer?: React.ReactElement
}) {
  const { t } = useTranslation()
  const resolved = useThemeStore((st) => st.resolved)
  const dark = resolved === 'dark'
  const tokens = getThemeTokens(resolved)
  const files = useMemo(() => parsePatch(patch), [patch])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const items = useMemo(() => buildDiffItems(files, collapsed), [files, collapsed])

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }, [])

  const renderItem = useCallback(
    ({ item }: { item: DiffItem }) => {
      switch (item.kind) {
        case 'file': {
          const Chevron = item.collapsed ? ChevronRight : ChevronDown
          return collapsible ? (
            <Pressable
              onPress={() => toggle(item.file.path)}
              style={[s.fileHead, { backgroundColor: tokens.muted, borderColor: tokens.border }]}
              accessibilityRole="button"
              accessibilityState={{ expanded: !item.collapsed }}
            >
              <Chevron size={14} color={tokens.mutedForeground} />
              <Text numberOfLines={1} style={[s.filePath, { color: tokens.foreground }]}>{item.file.path}</Text>
              {item.file.added > 0 && <Text style={s.plus}>+{item.file.added}</Text>}
              {item.file.removed > 0 && <Text style={[s.minus, { color: tokens.destructive }]}>-{item.file.removed}</Text>}
            </Pressable>
          ) : null
        }
        case 'hunk':
          return (
            <Text numberOfLines={1} style={[s.hunk, { color: tokens.mutedForeground, backgroundColor: tokens.muted }]}>
              {item.header}
            </Text>
          )
        case 'chunk':
          return <Chunk file={item.file} lines={item.lines} dark={dark} />
        case 'note':
          return (
            <Text style={[s.note, { color: tokens.mutedForeground }]}>
              {item.note === 'binary' ? t('changes.binary') : t('changes.noTextChanges')}
            </Text>
          )
      }
    },
    [collapsible, dark, t, toggle, tokens],
  )

  return (
    <FlatList
      data={items}
      keyExtractor={(it) => it.key}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      initialNumToRender={12}
      windowSize={7}
      contentContainerStyle={{ paddingBottom: 40 }}
    />
  )
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingRight: 16 },
  no: { width: GUTTER, textAlign: 'right', paddingRight: 6, fontSize: 10.5, fontFamily: MONO, lineHeight: 18 },
  sign: { width: 14, textAlign: 'center', fontSize: 11.5, fontFamily: MONO, lineHeight: 18 },
  code: { fontSize: 11.5, fontFamily: MONO, lineHeight: 18 },
  hunk: { fontSize: 10.5, fontFamily: MONO, paddingHorizontal: 10, paddingVertical: 3 },
  fileHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderTopWidth: 1, borderBottomWidth: 1, marginTop: 8 },
  filePath: { flex: 1, fontSize: 12.5, fontWeight: '600', fontFamily: MONO },
  plus: { fontSize: 12, color: '#10b981', fontWeight: '600' },
  minus: { fontSize: 12, fontWeight: '600' },
  note: { fontSize: 12, padding: 14 },
})
