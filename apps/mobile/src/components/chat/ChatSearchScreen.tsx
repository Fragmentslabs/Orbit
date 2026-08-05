import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, FileCode, MessageSquare, Search, X } from 'lucide-react-native'
import type { SearchHit } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

type SearchGroup = {
  sessionId: string
  title: string
  mode: string
  hits: SearchHit[]
}

export function ChatSearchScreen() {
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const searchSessions = useSessionStore((s) => s.searchSessions)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const inputRef = useRef<TextInput>(null)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 100)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    const timer = setTimeout(() => {
      void searchSessions(q)
        .then(setResults)
        .finally(() => setLoading(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [query, searchSessions])

  const groups = useMemo(() => {
    const map = new Map<string, SearchGroup>()
    for (const hit of results) {
      let group = map.get(hit.sessionId)
      if (!group) {
        group = {
          sessionId: hit.sessionId,
          title: hit.sessionTitle,
          mode: hit.mode,
          hits: [],
        }
        map.set(hit.sessionId, group)
      }
      group.hits.push(hit)
    }
    return [...map.values()]
  }, [results])

  const openHit = (hit: SearchHit) => {
    const mode = hit.mode === 'code' ? 'code' : 'chat'
    setMode(mode)
    router.replace({ pathname: '/(main)/chat/[id]', params: { id: hit.sessionId } })
  }

  const flatData = useMemo(() => {
    const rows: Array<
      | { kind: 'heading'; key: string; title: string }
      | { kind: 'hit'; key: string; hit: SearchHit }
    > = []
    for (const group of groups) {
      rows.push({ kind: 'heading', key: `h-${group.sessionId}`, title: group.title })
      group.hits.forEach((hit, i) => {
        rows.push({ kind: 'hit', key: `${group.sessionId}-${i}`, hit })
      })
    }
    return rows
  }, [groups])

  return (
    <SafeScreen>
      <View
        className="flex-row items-center gap-2 px-3 pb-3"
        style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          className="h-10 w-10 items-center justify-center rounded-full active:opacity-70"
        >
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View
          className="min-h-10 flex-1 flex-row items-center gap-2 rounded-xl px-3"
          style={{ backgroundColor: tokens.muted }}
        >
          <Search size={16} color={tokens.mutedForeground} />
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={setQuery}
            placeholder="Buscar conversas..."
            placeholderTextColor={tokens.mutedForeground}
            className="flex-1 py-2 text-base"
            style={{ color: tokens.foreground }}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="never"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} hitSlop={8} className="active:opacity-70">
              <X size={16} color={tokens.mutedForeground} />
            </Pressable>
          )}
        </View>
      </View>

      {loading && query.trim().length > 0 ? (
        <View className="flex-1 items-center justify-center py-12">
          <ActivityIndicator color={tokens.mutedForeground} />
        </View>
      ) : !query.trim() ? (
        <View className="flex-1 items-center justify-center px-8 py-12">
          <Text className="text-center text-sm" style={{ color: tokens.mutedForeground }}>
            Digite para buscar em todas as conversas
          </Text>
        </View>
      ) : results.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8 py-12">
          <Text className="text-center text-sm" style={{ color: tokens.mutedForeground }}>
            Nenhum resultado encontrado
          </Text>
        </View>
      ) : (
        <FlatList
          data={flatData}
          keyExtractor={(item) => item.key}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 24, paddingTop: 8 }}
          renderItem={({ item }) => {
            if (item.kind === 'heading') {
              return (
                <Text
                  className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide"
                  style={{ color: tokens.mutedForeground }}
                  numberOfLines={1}
                >
                  {item.title}
                </Text>
              )
            }
            const Icon = item.hit.mode === 'code' ? FileCode : MessageSquare
            return (
              <Pressable
                onPress={() => openHit(item.hit)}
                className="mx-2 flex-row items-center gap-3 rounded-xl px-3 py-3 active:opacity-80"
                style={{ backgroundColor: 'transparent' }}
              >
                <Icon size={16} color={tokens.mutedForeground} />
                <Text className="flex-1 text-sm" style={{ color: tokens.foreground }} numberOfLines={2}>
                  {item.hit.snippet}
                </Text>
              </Pressable>
            )
          }}
        />
      )}
    </SafeScreen>
  )
}
