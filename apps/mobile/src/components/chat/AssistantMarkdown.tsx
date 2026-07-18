import { useMemo } from 'react'
import { Linking, View, Text } from 'react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface AssistantMarkdownProps {
  text: string
}

type InlineSegment =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string }

type Block =
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'heading'; level: number; segments: InlineSegment[] }
  | { type: 'codeblock'; language: string; code: string }
  | { type: 'list'; items: InlineSegment[][] }
  | { type: 'hr' }
  | { type: 'blockquote'; segments: InlineSegment[] }

function parseInline(text: string): InlineSegment[] {
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g
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

function parseMarkdown(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') { i++; continue }
    if (line.trim() === '---') { blocks.push({ type: 'hr' }); i++; continue }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/)
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, segments: parseInline(headingMatch[2]) })
      i++; continue
    }

    const blockquoteMatch = line.match(/^>\s+(.*)$/)
    if (blockquoteMatch) {
      blocks.push({ type: 'blockquote', segments: parseInline(blockquoteMatch[1]) })
      i++; continue
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++
      blocks.push({ type: 'codeblock', language, code: codeLines.join('\n') })
      continue
    }

    const listMatch = line.match(/^[-*]\s+(.*)$/)
    if (listMatch) {
      const items: InlineSegment[][] = [parseInline(listMatch[1])]
      i++
      while (i < lines.length) {
        const nextItem = lines[i].match(/^[-*]\s+(.*)$/)
        if (nextItem) {
          items.push(parseInline(nextItem[1]))
          i++
        } else if (lines[i].trim() === '') {
          i++
          break
        } else {
          break
        }
      }
      blocks.push({ type: 'list', items })
      continue
    }

    const paraLines: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^(#{1,3}|```|>|---|[-*]\s)/)) {
      paraLines.push(lines[i])
      i++
    }
    const paraText = paraLines.join(' ')
    blocks.push({ type: 'paragraph', segments: parseInline(paraText) })
  }

  return blocks
}

function InlineText({ segments, color }: { segments: InlineSegment[]; color?: string }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <Text style={{ color }}>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case 'bold':
            return <Text key={i} className="font-bold" style={{ color }}>{seg.text}</Text>
          case 'italic':
            return <Text key={i} className="italic" style={{ color }}>{seg.text}</Text>
          case 'code':
            return (
              <Text key={i} className="font-mono text-xs px-1 rounded" style={{ backgroundColor: tokens.muted, color: tokens.foreground }}>
                {seg.text}
              </Text>
            )
          case 'link':
            return (
              <Text
                key={i}
                className="underline"
                style={{ color: tokens.primary }}
                onPress={() => Linking.openURL(seg.url)}
              >
                {seg.text}
              </Text>
            )
          default:
            return <Text key={i} style={{ color }}>{seg.text}</Text>
        }
      })}
    </Text>
  )
}

export function AssistantMarkdown({ text }: AssistantMarkdownProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const blocks = useMemo(() => parseMarkdown(text), [text])

  return (
    <View className="gap-1.5">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'paragraph':
            return <InlineText key={i} segments={block.segments} color={tokens.foreground} />
          case 'heading':
            return (
              <InlineText
                key={i}
                segments={block.segments}
                color={tokens.foreground}
              />
            )
          case 'codeblock':
            return (
              <View key={i} className="rounded-lg px-3 py-2" style={{ backgroundColor: tokens.muted }}>
                <Text className="text-xs font-mono leading-relaxed" style={{ color: tokens.foreground }}>
                  {block.code}
                </Text>
              </View>
            )
          case 'list':
            return (
              <View key={i} className="gap-1">
                {block.items.map((item, j) => (
                  <View key={j} className="flex-row items-start gap-2">
                    <Text className="text-sm mt-0.5" style={{ color: tokens.mutedForeground }}>•</Text>
                    <InlineText segments={item} color={tokens.foreground} />
                  </View>
                ))}
              </View>
            )
          case 'blockquote':
            return (
              <View key={i} className="pl-3" style={{ borderLeftWidth: 2, borderLeftColor: tokens.mutedForeground }}>
                <InlineText segments={block.segments} color={tokens.mutedForeground} />
              </View>
            )
          case 'hr':
            return <View key={i} className="h-px my-1" style={{ backgroundColor: tokens.border }} />
          default:
            return null
        }
      })}
    </View>
  )
}
