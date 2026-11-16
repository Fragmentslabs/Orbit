import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { FlatList, ScrollView, Text, View } from 'react-native'
import { darkSyntaxPalette, highlightCode, lightSyntaxPalette } from '~/lib/syntax-highlight'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { HIGHLIGHT_MAX_CHARS, languageOf, lineCount, longestLine, splitTokensByLine, type LineToken } from '~/lib/files'

export const CODE_FONT_SIZE = 13
export const CODE_LINE_HEIGHT = 20
/** Monospace advance is ~0.6em; a hair over so the widest line never wraps or clips. */
export const CODE_CHAR_WIDTH = CODE_FONT_SIZE * 0.61
const MONO = { fontFamily: 'Menlo' as const }
const MAX_WIDTH_CHARS = 4000

export interface CodeViewerHandle {
  scrollToLine: (line: number) => void
}

interface Props {
  content: string
  fileName: string
  /** Offsets of the find matches and which one is current. */
  matches?: number[]
  matchLength?: number
  currentMatch?: number
}

/**
 * Read-only code with line numbers. Virtualized by line (a 2 MB file is ~50k lines), and
 * horizontally scrollable instead of wrapped so the numbers stay aligned with the code.
 */
export const CodeViewer = forwardRef<CodeViewerHandle, Props>(function CodeViewer(
  { content, fileName, matches, matchLength = 0, currentMatch = -1 },
  ref,
) {
  const resolved = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(resolved)
  const palette = resolved === 'dark' ? darkSyntaxPalette : lightSyntaxPalette
  const list = useRef<FlatList<LineToken[]>>(null)

  const lines = useMemo<LineToken[][]>(() => {
    if (content.length > HIGHLIGHT_MAX_CHARS) {
      return content.split('\n').map((text) => (text ? [{ text, color: palette.foreground }] : []))
    }
    return splitTokensByLine(highlightCode(content, languageOf(fileName), palette))
  }, [content, fileName, palette])

  const gutter = String(Math.max(lineCount(content), 1)).length * CODE_CHAR_WIDTH + 16
  const width = gutter + Math.min(longestLine(content), MAX_WIDTH_CHARS) * CODE_CHAR_WIDTH + 24

  // Offsets → per-line column ranges, so the match can be painted inside its line.
  const lineMatches = useMemo(() => {
    const map = new Map<number, { col: number; current: boolean }[]>()
    if (!matches?.length || !matchLength) return map
    let line = 0
    let lineStart = 0
    let mi = 0
    for (let i = 0; i <= content.length && mi < matches.length; i++) {
      while (mi < matches.length && matches[mi] === i) {
        const arr = map.get(line) ?? []
        arr.push({ col: i - lineStart, current: mi === currentMatch })
        map.set(line, arr)
        mi++
      }
      if (content.charCodeAt(i) === 10) {
        line++
        lineStart = i + 1
      }
    }
    return map
  }, [content, matches, matchLength, currentMatch])

  useImperativeHandle(ref, () => ({
    scrollToLine: (line) => {
      list.current?.scrollToIndex({ index: Math.max(0, Math.min(line, lines.length - 1)), viewPosition: 0.3, animated: false })
    },
  }))

  return (
    <ScrollView horizontal style={{ flex: 1, backgroundColor: tokens.background }} contentContainerStyle={{ width: Math.max(width, 1) }}>
      <FlatList
        ref={list}
        data={lines}
        style={{ width }}
        keyExtractor={(_, i) => String(i)}
        getItemLayout={(_, index) => ({ length: CODE_LINE_HEIGHT, offset: CODE_LINE_HEIGHT * index, index })}
        initialNumToRender={40}
        windowSize={11}
        removeClippedSubviews
        renderItem={({ item, index }) => {
          const hits = lineMatches.get(index)
          return (
            <View style={{ flexDirection: 'row', height: CODE_LINE_HEIGHT, backgroundColor: hits?.some((h) => h.current) ? tokens.accent : undefined }}>
              <Text
                style={[MONO, { width: gutter, textAlign: 'right', paddingRight: 10, fontSize: CODE_FONT_SIZE - 1, lineHeight: CODE_LINE_HEIGHT, color: tokens.mutedForeground, opacity: 0.6 }]}
              >
                {index + 1}
              </Text>
              <Text style={[MONO, { fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT, color: palette.foreground }]}>
                {renderLine(item, hits, matchLength)}
              </Text>
            </View>
          )
        }}
      />
    </ScrollView>
  )
})

/** Splits the line's tokens at match boundaries so a match gets its own highlighted span. */
function renderLine(tokens: LineToken[], hits: { col: number; current: boolean }[] | undefined, len: number) {
  if (!hits?.length || !len) return tokens.map((tk, i) => <Text key={i} style={{ color: tk.color }}>{tk.text}</Text>)
  const out: React.ReactNode[] = []
  let col = 0
  let key = 0
  for (const tk of tokens) {
    let rest = tk.text
    let start = col
    while (rest.length) {
      const hit = hits.find((h) => h.col + len > start && h.col < start + rest.length)
      if (!hit) {
        out.push(<Text key={key++} style={{ color: tk.color }}>{rest}</Text>)
        break
      }
      const from = Math.max(hit.col, start) - start
      const to = Math.min(hit.col + len, start + rest.length) - start
      if (from > 0) out.push(<Text key={key++} style={{ color: tk.color }}>{rest.slice(0, from)}</Text>)
      out.push(
        <Text key={key++} style={{ color: tk.color, backgroundColor: hit.current ? '#f59e0b' : '#f59e0b55' }}>
          {rest.slice(from, to)}
        </Text>,
      )
      start += to
      rest = rest.slice(to)
    }
    col += tk.text.length
  }
  return out
}
