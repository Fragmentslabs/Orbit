import { useState, useMemo } from 'react'
import { View, Text, Pressable, ActivityIndicator, Linking, ScrollView, TouchableOpacity } from 'react-native'
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  CheckCircle,
  Clock,
  Globe,
  Search,
  Link,
  Paperclip,
  Bot,
  Terminal,
  Copy,
  Check,
  RotateCcw,
} from 'lucide-react-native'
import { Image } from 'expo-image'
import * as Clipboard from 'expo-clipboard'
import type {
  ChatMessage,
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolPart,
  AgentPart,
  ImagePart,
  FilePart,
} from '@orbit/shared'
import { cn } from '~/lib/utils'
import { AssistantMarkdown } from './AssistantMarkdown'
import { MessageActions } from './MessageActions'
import { MessageAttachment } from './Attachment'
import { Shimmer } from '~/components/ai/Shimmer'
import {
  messageText,
  extractSources,
  WEB_TOOLS,
  parseSearchResults,
  hostnameOf,
} from '~/lib/message-utils'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'

interface ChatAssistantMessageProps {
  message: ChatMessage
  compact?: boolean
  isLast?: boolean
  isBusy?: boolean
  onRevert?: () => void
}

// ─── User Message Attachments & Bubble ───────────────────────────────────────

function UserMessage({ message }: { message: ChatMessage }) {
  const text = messageText(message)
  const files = message.parts.filter((p): p is FilePart => p.type === 'file')
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <View className="self-end max-w-[85%] items-end my-1">
      {files.length > 0 && (
        <View className="flex-row flex-wrap gap-2 mb-1.5 justify-end">
          {files.map((file) => (
            <MessageAttachment key={file.id} file={file} />
          ))}
        </View>
      )}

      {text.trim().length > 0 && (
        <View className="px-4 py-2.5 rounded-2xl rounded-tr-sm" style={{ backgroundColor: tokens.muted }}>
          <Text className="text-sm leading-relaxed" style={{ color: tokens.foreground }}>
            {text}
          </Text>
        </View>
      )}
    </View>
  )
}

// ─── Reasoning (Raciocínio) ──────────────────────────────────────────────────

function ReasoningPartView({ part }: { part: ReasoningPart }) {
  const [open, setOpen] = useState(true)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const hsl = (v: string) => v.replace(/hsla?\(|\)/g, '').replace(/,/g, '')

  if (!part.text) return null

  const seconds = part.durationMs ? Math.max(1, Math.round(part.durationMs / 1000)) : undefined

  return (
    <View
      style={{
        marginVertical: 6,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: hslToRgba(hsl(tokens.border), 0.6),
        backgroundColor: hslToRgba(hsl(tokens.muted), 0.15),
        overflow: 'hidden',
        width: '100%',
      }}
    >
      <TouchableOpacity
        onPress={() => setOpen((prev) => !prev)}
        activeOpacity={0.7}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: hslToRgba(hsl(tokens.muted), 0.3),
        }}
      >
        <Clock size={12} color={tokens.mutedForeground} />
        <Text
          style={{
            fontSize: 12,
            fontWeight: '600',
            color: tokens.mutedForeground,
            flex: 1,
          }}
        >
          Raciocínio{seconds !== undefined ? ` · ${seconds}s` : ''}
        </Text>
        {part.state === 'streaming' && (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.75 }] }} color={tokens.mutedForeground} />
        )}
        {open ? (
          <ChevronDown size={14} color={tokens.mutedForeground} />
        ) : (
          <ChevronRight size={14} color={tokens.mutedForeground} />
        )}
      </TouchableOpacity>
      {open && (
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderTopWidth: 1,
            borderTopColor: hslToRgba(hsl(tokens.border), 0.2),
          }}
        >
          <Text
            style={{
              fontSize: 12,
              color: hslToRgba(hsl(tokens.mutedForeground), 0.8),
              fontStyle: 'italic',
              lineHeight: 18,
            }}
          >
            {part.text}
          </Text>
        </View>
      )}
    </View>
  )
}

// ─── Research Block (Grouping consecutive web tools) ───────────────────────

function ResearchStep({ part }: { part: ToolPart }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const input = part.input ?? {}
  const query = typeof input.query === 'string' ? input.query : undefined
  const url = typeof input.url === 'string' ? hostnameOf(input.url) : undefined
  const baseLabel = part.tool === 'websearch' ? 'Pesquisando' : 'Lendo página'
  const label = query ? `${baseLabel} "${query}"` : url ? `${baseLabel} ${url}` : baseLabel

  const results = part.tool === 'websearch' && part.output ? parseSearchResults(part.output) : []

  return (
    <View className="mt-1.5 pl-3 border-l border-border/40">
      <View className="flex-row items-center gap-1.5">
        {part.state === 'running' ? (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.75 }] }} color={tokens.primary} />
        ) : part.state === 'error' ? (
          <AlertCircle size={12} className="text-destructive" />
        ) : part.tool === 'websearch' ? (
          <Search size={12} className="text-muted-foreground" />
        ) : (
          <Globe size={12} className="text-muted-foreground" />
        )}
        <Text className={cn('text-xs', part.state === 'running' ? 'text-primary font-medium' : 'text-muted-foreground')}>
          {label}
        </Text>
      </View>

      {results.length > 0 && (
        <View className="flex-row flex-wrap gap-1.5 mt-1 ml-4">
          {results.slice(0, 4).map((res) => (
            <View key={res.url} className="flex-row items-center gap-1 bg-muted/40 rounded px-1.5 py-0.5">
              <Link size={10} className="text-muted-foreground" />
              <Text className="text-[10px] text-muted-foreground font-mono">{hostnameOf(res.url)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function ResearchBlock({ parts }: { parts: ToolPart[] }) {
  const researching = parts.some((p) => p.state === 'running')
  const [open, setOpen] = useState(researching)

  return (
    <View className="my-1.5 rounded-xl border border-border/60 bg-muted/10 overflow-hidden">
      <TouchableOpacity
        onPress={() => setOpen((prev) => !prev)}
        activeOpacity={0.7}
        className="flex-row items-center gap-2 px-3 py-2 bg-muted/20 cursor-pointer"
      >
        <Search size={13} className="text-primary" />
        <Text className="text-xs font-semibold text-foreground flex-1">
          {researching
            ? 'Pesquisando na web…'
            : `Pesquisa concluída · ${parts.length} ${parts.length === 1 ? 'etapa' : 'etapas'}`}
        </Text>
        {open ? (
          <ChevronDown size={14} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground" />
        )}
      </TouchableOpacity>
      {open && (
        <View className="px-3 pb-2.5">
          {parts.map((part) => (
            <ResearchStep key={part.id} part={part} />
          ))}
        </View>
      )}
    </View>
  )
}

// ─── Generic Tool Accordion ──────────────────────────────────────────────────

function GenericToolView({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const hsl = (v: string) => v.replace(/hsla?\(|\)/g, '').replace(/,/g, '')
  const detail = part.error ?? part.output

  return (
    <View
      style={{
        marginVertical: 6,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: hslToRgba(hsl(tokens.border), 0.6),
        backgroundColor: hslToRgba(hsl(tokens.muted), 0.15),
        overflow: 'hidden',
        width: '100%',
      }}
    >
      <TouchableOpacity
        onPress={() => setOpen((prev) => !prev)}
        activeOpacity={0.7}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: hslToRgba(hsl(tokens.muted), 0.3),
        }}
      >
        {part.state === 'running' ? (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.75 }] }} color={tokens.primary} />
        ) : part.state === 'error' ? (
          <AlertCircle size={13} color={tokens.destructive} />
        ) : (
          <Terminal size={13} color={tokens.mutedForeground} />
        )}
        <Text
          style={{
            fontSize: 12,
            fontWeight: '600',
            color: tokens.foreground,
            flex: 1,
            fontFamily: 'monospace',
          }}
        >
          {part.title ?? part.tool}
        </Text>
        {open ? (
          <ChevronDown size={14} color={tokens.mutedForeground} />
        ) : (
          <ChevronRight size={14} color={tokens.mutedForeground} />
        )}
      </TouchableOpacity>
      {open && detail && (
        <ScrollView
          style={{
            maxHeight: 200,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderTopWidth: 1,
            borderTopColor: hslToRgba(hsl(tokens.border), 0.3),
            backgroundColor: hslToRgba(hsl(tokens.muted), 0.1),
          }}
        >
          <Text
            style={{
              fontSize: 11,
              fontFamily: 'monospace',
              color: tokens.mutedForeground,
              lineHeight: 16,
            }}
          >
            {detail}
          </Text>
        </ScrollView>
      )}
    </View>
  )
}

// ─── Agent Accordion ─────────────────────────────────────────────────────────

function AgentPartView({ part }: { part: AgentPart }) {
  const [open, setOpen] = useState(part.state === 'running')
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <View className="my-1.5 rounded-xl border border-border/60 bg-muted/10 overflow-hidden">
      <TouchableOpacity
        onPress={() => setOpen((prev) => !prev)}
        activeOpacity={0.7}
        className="flex-row items-center gap-2 px-3 py-2 bg-muted/20 cursor-pointer"
      >
        <Bot size={13} className={part.state === 'running' ? 'text-yellow-500' : 'text-primary'} />
        <Text className="text-xs font-semibold text-foreground flex-1">
          {part.label}
        </Text>
        {part.state === 'running' && (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.75 }] }} color={tokens.primary} />
        )}
        {open ? (
          <ChevronDown size={14} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground" />
        )}
      </TouchableOpacity>
      {open && part.text && (
        <View className="px-3 py-2 border-t border-border/30">
          <Text className="text-xs text-muted-foreground leading-relaxed italic">
            {part.text}
          </Text>
        </View>
      )}
    </View>
  )
}

// ─── Sources List ────────────────────────────────────────────────────────────

function SourcesBlock({ sources }: { sources: any[] }) {
  const [open, setOpen] = useState(false)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const handleOpenLink = (url: string) => {
    Linking.openURL(url).catch((err) => console.error('Erro ao abrir link:', err))
  }

  return (
    <View className="mt-2.5">
      <TouchableOpacity
        onPress={() => setOpen((prev) => !prev)}
        activeOpacity={0.7}
        className="flex-row items-center gap-1 py-1 cursor-pointer"
      >
        <Text className="text-[11px] font-bold uppercase tracking-wider" style={{ color: tokens.mutedForeground }}>
          {sources.length} {sources.length === 1 ? 'Fonte Consultada' : 'Fontes Consultadas'}
        </Text>
        {open ? (
          <ChevronDown size={12} color={tokens.mutedForeground} />
        ) : (
          <ChevronRight size={12} color={tokens.mutedForeground} />
        )}
      </TouchableOpacity>

      {open && (
        <View className="gap-1 mt-1 pl-1">
          {sources.map((source, idx) => (
            <Pressable
              key={source.url + idx}
              onPress={() => handleOpenLink(source.url)}
              className="flex-row items-center gap-1.5 py-1 px-2 rounded-md"
            >
              <Link size={10} color={tokens.primary} />
              <Text className="text-xs underline truncate flex-1" numberOfLines={1} style={{ color: tokens.primary }}>
                {source.title || hostnameOf(source.url)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

// ─── Segment Parts helper ────────────────────────────────────────────────────

type Segment =
  | { kind: 'research'; id: string; parts: ToolPart[] }
  | { kind: 'part'; id: string; part: MessagePart }

function segmentParts(parts: MessagePart[]): Segment[] {
  const segments: Segment[] = []
  for (const part of parts) {
    if (part.type === 'tool' && WEB_TOOLS.has(part.tool)) {
      const last = segments[segments.length - 1]
      if (last?.kind === 'research') {
        last.parts.push(part)
      } else {
        segments.push({ kind: 'research', id: part.id, parts: [part] })
      }
    } else {
      segments.push({ kind: 'part', id: part.id, part })
    }
  }
  return segments
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(cost: number): string {
  if (cost >= 0.01) return `$${cost.toFixed(2)}`
  return `$${cost.toFixed(4)}`
}

export function ChatAssistantMessage({ message, compact, isLast, isBusy, onRevert }: ChatAssistantMessageProps) {
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const segments = useMemo(() => segmentParts(message.parts), [message.parts])
  const finished = message.error === undefined
  const sources = useMemo(() => (finished ? extractSources(message) : []), [finished, message])

  const waiting = message.role === 'assistant' && isLast && isBusy && message.parts.length === 0

  const handleCopy = async () => {
    await Clipboard.setStringAsync(messageText(message))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (isUser) {
    return <UserMessage message={message} />
  }

  // Find index of the last research block to mute text before it (desktop style)
  const lastToolIndex = segments.reduce(
    (last, segment, i) => (segment.kind === 'research' ? i : last),
    -1,
  )

  return (
    <View className="self-start w-full py-2 my-1 items-start">
      {waiting && (
        <View className="py-1">
          <Shimmer className="text-sm font-semibold">Pensando…</Shimmer>
        </View>
      )}

      {segments.map((segment, index) => {
        if (segment.kind === 'research') {
          return <ResearchBlock key={segment.id} parts={segment.parts} />
        }

        const part = segment.part
        switch (part.type) {
          case 'text':
            // Durante o streaming renderiza texto puro — o parse de markdown
            // a cada delta era o maior custo por frame; a formatação entra
            // quando a parte fecha (state: done).
            return (
              <View key={part.id} className="w-full">
                {part.state === 'streaming' ? (
                  <Text className="text-sm leading-relaxed" style={{ color: tokens.foreground }}>
                    {part.text}
                    <Text style={{ color: tokens.primary }}> ▊</Text>
                  </Text>
                ) : (
                  <AssistantMarkdown text={part.text} />
                )}
              </View>
            )
          case 'reasoning':
            return <ReasoningPartView key={part.id} part={part} />
          case 'tool':
            return <GenericToolView key={part.id} part={part} />
          case 'agent':
            return <AgentPartView key={part.id} part={part} />
          case 'image':
            return (
              <View key={part.id} className="mt-2 rounded-lg overflow-hidden" style={{ borderWidth: 1, borderColor: tokens.border }}>
                <Image
                  source={part.src}
                  style={{ width: 240, height: 180 }}
                  contentFit="contain"
                />
              </View>
            )
          default:
            return null
        }
      })}

      {message.error && (
        <View className="mt-2 w-full rounded-lg px-3 py-2" style={{ borderWidth: 1, borderColor: tokens.destructive, backgroundColor: tokens.destructive + '1A' }}>
          <Text className="text-xs" style={{ color: tokens.destructive }}>{message.error}</Text>
        </View>
      )}

      {/* Render Actions (copy + revert + timestamp & token/cost summary) */}
      <View className="mt-2.5 w-full flex-row items-center flex-wrap gap-3 pt-2 opacity-60" style={{ borderTopWidth: 1, borderTopColor: tokens.border }}>
        <Pressable onPress={handleCopy} className="p-0.5 rounded">
          {copied ? (
            <CheckCircle size={13} color={tokens.primary} />
          ) : (
            <Copy size={13} color={tokens.mutedForeground} />
          )}
        </Pressable>

        {onRevert && (
          <Pressable onPress={onRevert} className="p-0.5 rounded">
            <RotateCcw size={13} color={tokens.mutedForeground} />
          </Pressable>
        )}

        <Text className="text-[10px] font-mono" style={{ color: tokens.mutedForeground }}>
          {formatTime(message.createdAt)}
        </Text>

        {message.tokens && (
          <Text className="text-[10px] font-mono" style={{ color: tokens.mutedForeground }}>
            · {formatTokens(message.tokens.input)} in · {formatTokens(message.tokens.output)} out
            {message.tokens.cacheRead > 0 && ` · ${formatTokens(message.tokens.cacheRead)} cache`}
            {message.tokens.cost !== undefined && ` · ${formatCost(message.tokens.cost)}`}
          </Text>
        )}
      </View>

      {/* Sources list */}
      {finished && sources.length > 0 && <SourcesBlock sources={sources} />}
    </View>
  )
}
