import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { View, Text, Pressable, ActivityIndicator, Linking, ScrollView, TouchableOpacity } from 'react-native'
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Clock,
  Globe,
  Search,
  Link,
  Paperclip,
  Bot,
  Terminal,
} from 'lucide-react-native'
import { Image } from 'expo-image'
import * as Clipboard from 'expo-clipboard'
import { useTranslation } from 'react-i18next'
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
import { SkillProposalCard } from './SkillProposalCard'
import { Shimmer } from '~/components/ai/Shimmer'
import { SubAgentCard } from '~/components/chat/SubAgentCard'
import {
  messageText,
  visibleMessageText,
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

function UserMessage({ message, onRevert }: { message: ChatMessage; onRevert?: () => void }) {
  const text = visibleMessageText(message)
  const files = message.parts.filter((p): p is FilePart => p.type === 'file')
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(text)
  }, [text])

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

      <MessageActions message={message} onCopy={handleCopy} onRevert={onRevert} />
    </View>
  )
}

// ─── Reasoning (Raciocínio) ──────────────────────────────────────────────────

function ReasoningPartView({ part }: { part: ReasoningPart }) {
  const { t } = useTranslation()
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
          {t('chatAssistant.reasoning')}{seconds !== undefined ? ` · ${seconds}s` : ''}
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
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const input = part.input ?? {}
  const query = typeof input.query === 'string' ? input.query : undefined
  const url = typeof input.url === 'string' ? hostnameOf(input.url) : undefined
  const baseLabel = part.tool === 'websearch' ? t('chatAssistant.searchingLabel') : t('chatAssistant.readingPageLabel')
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
  const { t } = useTranslation()
  const researching = parts.some((p) => p.state === 'running')
  const [open, setOpen] = useState(researching)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const hsl = (v: string) => v.replace(/hsla?\(|\)/g, '').replace(/,/g, '')

  useEffect(() => {
    setOpen(researching)
  }, [researching])

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
        <Search size={13} color={tokens.primary} />
        <Text
          style={{
            fontSize: 12,
            fontWeight: '600',
            color: tokens.foreground,
            flex: 1,
          }}
        >
          {researching
            ? t('chatAssistant.searchingWeb')
            : t('chatAssistant.searchDone', { count: parts.length })}
        </Text>
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
            paddingBottom: 10,
          }}
        >
          {parts.map((part) => (
            <ResearchStep key={part.id} part={part} />
          ))}
        </View>
      )}
    </View>
  )
}

// ─── Task group (tools limitadas, acordeon — espelho do desktop code mode) ───

const MAX_VISIBLE_TOOLS = 5

function toolChip(part: ToolPart): string | undefined {
  const input = part.input ?? {}
  const candidate = input.filePath ?? input.dirPath ?? input.pattern ?? input.query ?? input.url ?? input.command
  if (typeof candidate !== 'string' || !candidate) return undefined
  const isPath = typeof input.filePath === 'string' || typeof input.dirPath === 'string'
  return isPath ? candidate.split(/[\\/]/).pop() : candidate
}

function ToolActionRow({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const [showOutput, setShowOutput] = useState(false)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const label = t(`chatAssistant.actionLabels.${part.tool}`, { defaultValue: part.title ?? part.tool })
  const chip = toolChip(part)
  const detail = part.error ?? (part.tool === 'bash' ? part.output : part.output)

  return (
    <View style={{ marginTop: 6, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: tokens.border }}>
      <Pressable
        onPress={() => detail && setShowOutput((v) => !v)}
        disabled={!detail}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
      >
        {part.state === 'running' ? (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.7 }] }} color={tokens.primary} />
        ) : part.state === 'error' ? (
          <AlertCircle size={12} color={tokens.destructive} />
        ) : (
          <Terminal size={12} color={tokens.mutedForeground} />
        )}
        {part.state === 'running' ? (
          <Shimmer className="text-xs font-medium">{label}</Shimmer>
        ) : (
          <Text
            style={{
              fontSize: 12,
              color: part.state === 'error' ? tokens.destructive : tokens.foreground,
              fontWeight: '500',
            }}
          >
            {label}
          </Text>
        )}
        {chip ? (
          <View
            style={{
              backgroundColor: tokens.muted,
              borderRadius: 6,
              paddingHorizontal: 6,
              paddingVertical: 2,
              maxWidth: 180,
            }}
          >
            <Text numberOfLines={1} style={{ fontSize: 10, fontFamily: 'monospace', color: tokens.mutedForeground }}>
              {chip}
            </Text>
          </View>
        ) : null}
        {detail ? (
          showOutput ? (
            <ChevronDown size={12} color={tokens.mutedForeground} />
          ) : (
            <ChevronRight size={12} color={tokens.mutedForeground} />
          )
        ) : null}
      </Pressable>
      {showOutput && detail ? (
        <ScrollView style={{ maxHeight: 160, marginTop: 6 }} nestedScrollEnabled>
          <Text style={{ fontSize: 11, fontFamily: 'monospace', color: tokens.mutedForeground, lineHeight: 16 }}>
            {detail}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  )
}

function TaskGroup({ parts }: { parts: ToolPart[] }) {
  const { t } = useTranslation()
  const working = parts.some((p) => p.state === 'running')
  const errors = parts.filter((p) => p.state === 'error').length
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const prevWorking = useRef(working)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const hsl = (v: string) => v.replace(/hsla?\(|\)/g, '').replace(/,/g, '')

  useEffect(() => {
    if (working) setOpen(true)
  }, [working])

  useEffect(() => {
    if (prevWorking.current && !working) {
      const timer = setTimeout(() => setOpen(false), 1000)
      return () => clearTimeout(timer)
    }
    prevWorking.current = working
  }, [working])

  useEffect(() => {
    setShowAll(false)
  }, [parts.length])

  const visibleParts = showAll ? parts : parts.slice(-MAX_VISIBLE_TOOLS)
  const hiddenCount = parts.length - MAX_VISIBLE_TOOLS

  const title = working
    ? t('chatAssistant.working')
    : errors > 0
      ? t('chatAssistant.actionsWithErrors', { count: parts.length, errors })
      : t('chatAssistant.actionsExecuted', { count: parts.length })

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
        {working ? (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.75 }] }} color={tokens.primary} />
        ) : (
          <Terminal size={13} color={tokens.mutedForeground} />
        )}
        {working ? (
          <View style={{ flex: 1 }}>
            <Shimmer className="text-xs font-semibold">{title}</Shimmer>
          </View>
        ) : (
          <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.foreground, flex: 1 }}>{title}</Text>
        )}
        {open ? (
          <ChevronDown size={14} color={tokens.mutedForeground} />
        ) : (
          <ChevronRight size={14} color={tokens.mutedForeground} />
        )}
      </TouchableOpacity>
      {open && (
        <View style={{ paddingHorizontal: 12, paddingBottom: 10 }}>
          {visibleParts.map((part) => (
            <ToolActionRow key={part.id} part={part} />
          ))}
          {hiddenCount > 0 && !showAll && (
            <Pressable onPress={() => setShowAll(true)} style={{ marginTop: 8 }}>
              <Text style={{ fontSize: 11, color: tokens.mutedForeground }}>
                {t('chatAssistant.hiddenActions', { count: hiddenCount })}
              </Text>
            </Pressable>
          )}
        </View>
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
  const { t } = useTranslation()
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
          {t('chatAssistant.sourcesConsulted', { count: sources.length })}
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

const SPECIAL_TOOLS = new Set(['subagent', 'todowrite', 'create_skill', 'show_image'])

type Segment =
  | { kind: 'research'; id: string; parts: ToolPart[] }
  | { kind: 'task'; id: string; parts: ToolPart[] }
  | { kind: 'part'; id: string; part: MessagePart }

function segmentParts(parts: MessagePart[]): Segment[] {
  const segments: Segment[] = []
  for (const part of parts) {
    if (part.type === 'tool' && WEB_TOOLS.has(part.tool)) {
      const last = segments[segments.length - 1]
      if (last?.kind === 'research') last.parts.push(part)
      else segments.push({ kind: 'research', id: part.id, parts: [part] })
    } else if (part.type === 'tool' && !SPECIAL_TOOLS.has(part.tool)) {
      const last = segments[segments.length - 1]
      if (last?.kind === 'task') last.parts.push(part)
      else segments.push({ kind: 'task', id: part.id, parts: [part] })
    } else {
      segments.push({ kind: 'part', id: part.id, part })
    }
  }
  return segments
}

export function ChatAssistantMessage({ message, compact, isLast, isBusy, onRevert }: ChatAssistantMessageProps) {
  const { t } = useTranslation()
  const isUser = message.role === 'user'
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const segments = useMemo(() => segmentParts(message.parts), [message.parts])
  const finished = message.error === undefined
  const sources = useMemo(() => (finished ? extractSources(message) : []), [finished, message])

  const waiting = message.role === 'assistant' && isLast && isBusy && message.parts.length === 0

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(messageText(message))
  }, [message])

  if (isUser) {
    return <UserMessage message={message} onRevert={onRevert} />
  }

  return (
    <View className="self-start w-full py-2 my-1 items-start">
      {waiting && (
        <View className="py-1">
          <Shimmer className="text-sm font-semibold">{t('chatAssistant.thinking')}</Shimmer>
        </View>
      )}

      {segments.map((segment) => {
        if (segment.kind === 'research') {
          return <ResearchBlock key={segment.id} parts={segment.parts} />
        }
        if (segment.kind === 'task') {
          return <TaskGroup key={segment.id} parts={segment.parts} />
        }

        const part = segment.part
        switch (part.type) {
          case 'text':
            return (
              <View key={part.id} className="w-full">
                <AssistantMarkdown text={part.text} streaming={part.state === 'streaming'} />
              </View>
            )
          case 'reasoning':
            return <ReasoningPartView key={part.id} part={part} />
          case 'tool':
            if (part.tool === 'subagent') {
              return <SubAgentCard key={part.id} part={part} />
            }
            if (part.tool === 'create_skill') {
              return <SkillProposalCard key={part.id} part={part as ToolPart} />
            }
            // tools especiais que não entram no TaskGroup
            return <TaskGroup key={part.id} parts={[part]} />
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
          case 'file':
            return (
              <View key={part.id} className="mt-1 w-full">
                <MessageAttachment file={part} />
              </View>
            )
          default:
            return null
        }
      })}

      {message.error && (
        <View className="mt-2 w-full rounded-lg px-3 py-2" style={{ borderWidth: 1, borderColor: tokens.destructive, backgroundColor: hslToRgba(tokens.destructive.replace(/hsla?\(|\)/g, '').replace(/,/g, ''), 0.12) }}>
          <Text className="text-xs" style={{ color: tokens.destructive }}>{message.error}</Text>
        </View>
      )}

      <MessageActions message={message} onCopy={handleCopy} onRevert={onRevert} />

      {/* Sources list */}
      {finished && sources.length > 0 && <SourcesBlock sources={sources} />}
    </View>
  )
}
