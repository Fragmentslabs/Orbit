import { memo, useMemo } from 'react'
import { Linking, View, Text } from 'react-native'
import { CodeBlock } from '~/components/chat/CodeBlock'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface AssistantMarkdownProps {
  text: string
  /** Durante streaming: parse leve, code block sem highlight, caret no fim. */
  streaming?: boolean
  /** Texto secundário (ex.: reasoning) em cor muted e headings menores. */
  muted?: boolean
  /** Tamanho do corpo (padrão 14). */
  size?: number
}

type InlineSegment =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string }

type ListItem = {
  depth: number
  ordered: boolean
  index: number
  checked: boolean | null
  segments: InlineSegment[]
}

type Block =
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'heading'; level: number; segments: InlineSegment[] }
  | { type: 'codeblock'; language: string; code: string; incomplete?: boolean }
  | { type: 'list'; items: ListItem[] }
  | { type: 'hr' }
  | { type: 'blockquote'; segments: InlineSegment[] }
  | { type: 'table'; headers: InlineSegment[][]; rows: InlineSegment[][][] }

/** Fecha fences/ênfases incompletas para o parse não quebrar no meio do stream. */
function stabilizeMarkdown(text: string): string {
  let out = text
  const fenceMatches = out.match(/^```/gm)
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    out += '\n```'
  }
  // Pares ímpares de ** ou * no trecho fora de code fences — evita itálico “preso”
  const withoutFences = out.replace(/```[\s\S]*?```/g, '')
  const boldCount = (withoutFences.match(/\*\*/g) ?? []).length
  if (boldCount % 2 === 1) out += '**'
  return out
}

function parseInline(text: string): InlineSegment[] {
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g
  const segments: InlineSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    }
    if (match[2]) {
      segments.push({ type: 'bold', text: match[2] })
    } else if (match[4]) {
      segments.push({ type: 'italic', text: match[4] })
    } else if (match[6]) {
      segments.push({ type: 'code', text: match[6] })
    } else if (match[8] && match[9]) {
      segments.push({ type: 'link', text: match[8], url: match[9] })
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) })
  }

  return segments.length > 0 ? segments : [{ type: 'text', text }]
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/
const HEADING_RE = /^(#{1,3})\s+(.*)$/
const BLOCKQUOTE_RE = /^>\s?(.*)$/
const TABLE_ROW_RE = /^\|(.+)\|$/
const TABLE_SEP_RE = /^\|[-:\s|]+\|$/

function listDepth(indent: string): number {
  // 2 espaços ou 1 tab = 1 nível
  const spaces = indent.replace(/\t/g, '  ').length
  return Math.floor(spaces / 2)
}

function parseMarkdown(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i++
      continue
    }
    if (line.trim() === '---' || line.trim() === '***') {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    const headingMatch = line.match(HEADING_RE)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        segments: parseInline(headingMatch[2]),
      })
      i++
      continue
    }

    const blockquoteMatch = line.match(BLOCKQUOTE_RE)
    if (blockquoteMatch) {
      const segs = [blockquoteMatch[1]]
      i++
      while (i < lines.length) {
        const next = lines[i].match(BLOCKQUOTE_RE)
        if (!next) break
        segs.push(next[1])
        i++
      }
      blocks.push({ type: 'blockquote', segments: parseInline(segs.join(' ')) })
      continue
    }

    if (line.trimStart().startsWith('```')) {
      const open = line.trimStart()
      const language = open.slice(3).trim()
      const codeLines: string[] = []
      i++
      let closed = false
      while (i < lines.length) {
        if (lines[i].trimStart().startsWith('```')) {
          closed = true
          i++
          break
        }
        codeLines.push(lines[i])
        i++
      }
      blocks.push({
        type: 'codeblock',
        language,
        code: codeLines.join('\n'),
        incomplete: !closed,
      })
      continue
    }

    const listMatch = line.match(LIST_RE)
    if (listMatch) {
      const items: ListItem[] = []
      const counters: number[] = []
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE)
        if (!m) {
          // Continuação indentada de item (sem bullet) — anexa ao último
          if (items.length > 0 && /^\s{2,}\S/.test(lines[i]) && lines[i].trim() !== '') {
            const last = items[items.length - 1]
            const plain = last.segments.map((s) => s.text).join('')
            last.segments = parseInline(`${plain} ${lines[i].trim()}`)
            i++
            continue
          }
          if (lines[i].trim() === '') {
            if (i + 1 < lines.length && LIST_RE.test(lines[i + 1])) {
              i++
              continue
            }
            break
          }
          break
        }
        const depth = listDepth(m[1])
        const ordered = /^\d+\./.test(m[2])
        const checked = m[3] === undefined ? null : m[3].toLowerCase() === 'x'
        while (counters.length <= depth) counters.push(0)
        counters[depth] = ordered ? counters[depth] + 1 : 0
        for (let d = depth + 1; d < counters.length; d++) counters[d] = 0
        const num = ordered ? parseInt(m[2], 10) || counters[depth] : counters[depth]
        items.push({
          depth,
          ordered,
          index: num,
          checked,
          segments: parseInline(m[4] ?? ''),
        })
        i++
      }
      if (items.length > 0) {
        blocks.push({ type: 'list', items })
      }
      continue
    }

    const tableMatch = line.match(TABLE_ROW_RE)
    if (tableMatch && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const headers = tableMatch[1].split('|').map((h) => parseInline(h.trim()))
      i += 2
      const rows: InlineSegment[][][] = []
      while (i < lines.length && lines[i].trim() !== '' && TABLE_ROW_RE.test(lines[i])) {
        const raw = lines[i].replace(/^\|/, '').replace(/\|$/, '')
        rows.push(raw.split('|').map((c) => parseInline(c.trim())))
        i++
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    const paraLines: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !HEADING_RE.test(lines[i]) &&
      !lines[i].trimStart().startsWith('```') &&
      !BLOCKQUOTE_RE.test(lines[i]) &&
      lines[i].trim() !== '---' &&
      !LIST_RE.test(lines[i]) &&
      !TABLE_ROW_RE.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push({ type: 'paragraph', segments: parseInline(paraLines.join(' ')) })
  }

  return blocks
}

const InlineText = memo(function InlineText({
  segments,
  color,
  size = 14,
  weight,
}: {
  segments: InlineSegment[]
  color?: string
  size?: number
  weight?: '400' | '600' | '700'
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <Text style={{ color, fontSize: size, fontWeight: weight, lineHeight: size * 1.45, flexShrink: 1 }}>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case 'bold':
            return (
              <Text key={i} style={{ color, fontWeight: '700' }}>
                {seg.text}
              </Text>
            )
          case 'italic':
            return (
              <Text key={i} style={{ color, fontStyle: 'italic' }}>
                {seg.text}
              </Text>
            )
          case 'code':
            return (
              <Text
                key={i}
                style={{
                  fontFamily: 'monospace',
                  fontSize: size - 2,
                  backgroundColor: tokens.muted,
                  color: tokens.foreground,
                  borderRadius: 4,
                  paddingHorizontal: 4,
                }}
              >
                {seg.text}
              </Text>
            )
          case 'link':
            return (
              <Text
                key={i}
                style={{ color: tokens.primary, textDecorationLine: 'underline' }}
                onPress={() => Linking.openURL(seg.url)}
              >
                {seg.text}
              </Text>
            )
          default:
            return (
              <Text key={i} style={{ color }}>
                {seg.text}
              </Text>
            )
        }
      })}
    </Text>
  )
})

const HEADING_SIZE = [20, 17, 15] as const

function ListBlock({ items, color, muted, size = 14 }: { items: ListItem[]; color: string; muted: string; size?: number }) {
  return (
    <View style={{ gap: 4 }}>
      {items.map((item, j) => {
        const pad = item.depth * 14
        let bullet: string
        if (item.checked === true) bullet = '☑'
        else if (item.checked === false) bullet = '☐'
        else if (item.ordered) bullet = `${item.index}.`
        else bullet = item.depth % 2 === 0 ? '•' : '◦'

        return (
          <View key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingLeft: pad }}>
            <Text
              style={{
                color: muted,
                fontSize: 13,
                lineHeight: 20,
                minWidth: item.ordered ? 18 : 12,
                fontVariant: item.ordered ? ['tabular-nums'] : undefined,
              }}
            >
              {bullet}
            </Text>
            <View style={{ flex: 1 }}>
              <InlineText
                segments={item.segments}
                color={color}
                size={size}
              />
            </View>
          </View>
        )
      })}
    </View>
  )
}

function AssistantMarkdownInner({ text, streaming = false, muted = false, size = 14 }: AssistantMarkdownProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const bodyColor = muted ? tokens.mutedForeground : tokens.foreground
  const blocks = useMemo(() => {
    const source = streaming ? stabilizeMarkdown(text) : text
    return parseMarkdown(source)
  }, [text, streaming])

  return (
    <View style={{ gap: 6 }}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'paragraph':
            return <InlineText key={i} segments={block.segments} color={bodyColor} size={size} />
          case 'heading':
            return (
              <InlineText
                key={i}
                segments={block.segments}
                color={bodyColor}
                size={Math.max(13, HEADING_SIZE[Math.min(block.level, 3) - 1] - (muted ? 5 : 0))}
                weight="700"
              />
            )
          case 'codeblock':
            return (
              <CodeBlock
                key={i}
                code={block.code}
                language={block.language}
                streaming={streaming || block.incomplete}
              />
            )
          case 'list':
            return (
              <ListBlock
                key={i}
                items={block.items}
                color={bodyColor}
                muted={tokens.mutedForeground}
                size={size}
              />
            )
          case 'table':
            return (
              <View
                key={i}
                style={{ borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: tokens.border }}
              >
                <View style={{ backgroundColor: tokens.muted }}>
                  <View style={{ flexDirection: 'row' }}>
                    {block.headers.map((header, ci) => (
                      <View
                        key={ci}
                        style={{
                          flex: 1,
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRightWidth: ci < block.headers.length - 1 ? 1 : 0,
                          borderColor: tokens.border,
                        }}
                      >
                        <InlineText segments={header} color={tokens.foreground} size={13} weight="600" />
                      </View>
                    ))}
                  </View>
                </View>
                {block.rows.map((row, ri) => (
                  <View
                    key={ri}
                    style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: tokens.border }}
                  >
                    {row.map((cell, ci) => (
                      <View
                        key={ci}
                        style={{
                          flex: 1,
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRightWidth: ci < row.length - 1 ? 1 : 0,
                          borderColor: tokens.border,
                        }}
                      >
                        <InlineText segments={cell} color={tokens.foreground} size={13} />
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            )
          case 'blockquote':
            return (
              <View
                key={i}
                style={{
                  paddingLeft: 12,
                  borderLeftWidth: 2,
                  borderLeftColor: tokens.mutedForeground,
                }}
              >
                <InlineText segments={block.segments} color={tokens.mutedForeground} size={14} />
              </View>
            )
          case 'hr':
            return <View key={i} style={{ height: 1, marginVertical: 4, backgroundColor: tokens.border }} />
          default:
            return null
        }
      })}
      {streaming && (
        <Text style={{ color: tokens.primary, fontSize: 14, lineHeight: 20 }}>▊</Text>
      )}
    </View>
  )
}

export const AssistantMarkdown = memo(AssistantMarkdownInner)
