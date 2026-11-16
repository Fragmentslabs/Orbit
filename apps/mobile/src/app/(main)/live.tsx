/**
 * Live view of the browser / computer the agent is driving on the desktop (`/live?sessionId&kind`).
 * View-first: the frame, what the agent is doing and the actions feed, plus Stop. There is no
 * tap/type forwarding — the desktop has no safe remote-input API for these panels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, FlatList, Pressable, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Image } from 'expo-image'
import { ArrowLeft, Globe, Monitor, Square } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { LiveKind } from '@orbit/shared'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { elapsedLabel, feedNewestFirst, frameAspect, hostLabel, isBusy, nextPollDelay } from '~/lib/live-logic'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useLiveStore } from '~/stores/live-store'
import { useThemeStore } from '~/stores/theme-store'

export default function LiveScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const confirm = useConfirm()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const params = useLocalSearchParams<{ sessionId?: string; kind?: string }>()
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
  const kind: LiveKind = params.kind === 'computer' ? 'computer' : 'browser'
  const key = `${kind}:${sessionId}`

  const state = useLiveStore((s) => s.states[key])
  const frame = useLiveStore((s) => s.frames[key])
  const status = useLiveStore((s) => s.status[key])
  const failures = useLiveStore((s) => s.failures[key] ?? 0)
  const fetchFrame = useLiveStore((s) => s.fetchFrame)
  const [now, setNow] = useState(() => Date.now())
  const [visible, setVisible] = useState(AppState.currentState === 'active')
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setVisible(next === 'active'))
    return () => sub.remove()
  }, [])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Pull loop: one request at a time (the store drops overlaps), paced by the surface's activity.
  const stateRef = useRef(state)
  const failuresRef = useRef(failures)
  useEffect(() => {
    stateRef.current = state
    failuresRef.current = failures
  }, [state, failures])
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (cancelled) return
      const delay = nextPollDelay({ state: stateRef.current ?? null, now: Date.now(), failures: failuresRef.current, visible })
      // First pull happens even before we know the state (opened from a notification, desktop answers closed/404).
      if (delay === null && stateRef.current) return
      await fetchFrame(sessionId, kind)
      if (cancelled) return
      const next = nextPollDelay({ state: stateRef.current ?? null, now: Date.now(), failures: failuresRef.current, visible })
      if (next !== null) timer = setTimeout(tick, next)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, kind, visible, fetchFrame])

  // A pushed "new frame" revision pulls right away instead of waiting for the next tick.
  const rev = state?.frameRev ?? 0
  useEffect(() => {
    if (rev > 0 && visible && state?.active) void fetchFrame(sessionId, kind)
  }, [rev]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStop = useCallback(async () => {
    const ok = await confirm({
      title: t('live.stopTitle'),
      description: t(kind === 'computer' ? 'live.stopComputer' : 'live.stopBrowser'),
      confirmLabel: t('live.stop'),
      cancelLabel: t('live.cancel'),
      destructive: true,
    })
    if (!ok) return
    setStopping(true)
    await useLiveStore.getState().stop(sessionId, kind)
    setStopping(false)
  }, [confirm, kind, sessionId, t])

  const feed = useMemo(() => feedNewestFirst(state?.feed ?? []), [state?.feed])
  const active = Boolean(state?.active)
  const busy = isBusy(state ?? null, now)
  const Icon = kind === 'computer' ? Monitor : Globe
  const title = kind === 'computer' ? t('live.computerTitle', { app: state?.app ?? '' }) : state?.title || t('live.browserTitle')
  const subtitle = kind === 'computer' ? '' : hostLabel(state?.url ?? null)

  const emptyText = (() => {
    if (!active && state) return t('live.closed')
    if (status === 'error') return t('live.offline')
    if (status === 'no-frame') return t('live.noFrame')
    if (status === 'capture-failed') return t('live.captureFailed')
    if (status === 'closed' || (!state && status === 'idle')) return t('live.closed')
    return null
  })()

  return (
    <SafeScreen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 }}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('live.back')}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Icon size={18} color={tokens.mutedForeground} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: tokens.foreground }}>{title}</Text>
          {subtitle ? <Text numberOfLines={1} style={{ fontSize: 12, color: tokens.mutedForeground }}>{subtitle}</Text> : null}
        </View>
        {active ? (
          <Pressable
            onPress={handleStop}
            disabled={stopping}
            accessibilityRole="button"
            accessibilityLabel={t('live.stop')}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: withAlpha(tokens.destructive, 0.15), opacity: stopping ? 0.5 : 1 }}
          >
            <Square size={11} color={tokens.destructive} fill={tokens.destructive} />
            <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.destructive }}>{t('live.stop')}</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={{ marginHorizontal: 12, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.muted, aspectRatio: frameAspect(frame ?? null), maxHeight: '55%' }}>
        {frame ? (
          <>
            <Image source={{ uri: frame.dataUrl }} style={{ flex: 1 }} contentFit="fill" transition={120} accessibilityLabel={t('live.frameAlt')} />
            {frame.marker ? <Marker marker={frame.marker} width={frame.width} height={frame.height} color={tokens.primary} /> : null}
          </>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            {emptyText ? (
              <Text style={{ textAlign: 'center', fontSize: 13, color: tokens.mutedForeground }}>{emptyText}</Text>
            ) : (
              <ActivityIndicator color={tokens.mutedForeground} />
            )}
          </View>
        )}
        {frame && !active ? (
          <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(tokens.background, 0.6) }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: tokens.foreground }}>{t('live.closed')}</Text>
          </View>
        ) : null}
        {frame && active && status === 'error' ? (
          <View style={{ position: 'absolute', left: 8, top: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: withAlpha(tokens.background, 0.8) }}>
            <Text style={{ fontSize: 11, color: tokens.warning }}>{t('live.offline')}</Text>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: busy ? tokens.success : tokens.mutedForeground }} />
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: '600', color: tokens.foreground }}>
          {active ? state?.action ?? t('live.waiting') : t('live.ended')}
        </Text>
        {active && state?.startedAt ? <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>{elapsedLabel(state.startedAt, now)}</Text> : null}
      </View>

      <FlatList
        data={feed}
        keyExtractor={(a) => String(a.id)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        ListHeaderComponent={<Text style={{ fontSize: 11, fontWeight: '600', letterSpacing: 0.6, color: tokens.mutedForeground, marginBottom: 6 }}>{t('live.feed').toUpperCase()}</Text>}
        ListEmptyComponent={<Text style={{ fontSize: 13, color: tokens.mutedForeground }}>{t('live.feedEmpty')}</Text>}
        renderItem={({ item, index }) => (
          <View style={{ flexDirection: 'row', gap: 10, paddingVertical: 6, opacity: index === 0 && active ? 1 : 0.75 }}>
            <Text style={{ width: 52, fontSize: 11, color: tokens.mutedForeground }}>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Text>
            <Text style={{ flex: 1, fontSize: 13, color: tokens.foreground }}>{item.label}</Text>
          </View>
        )}
      />
    </SafeScreen>
  )
}

/** Where the last action landed, drawn over the frame in the frame's own pixel space. */
function Marker({ marker, width, height, color }: { marker: { x: number; y: number; w: number; h: number }; width: number; height: number; color: string }) {
  const point = marker.w < 4 && marker.h < 4
  const pct = (v: number, total: number) => `${(v / total) * 100}%` as const
  return point ? (
    <View pointerEvents="none" style={{ position: 'absolute', left: pct(marker.x, width), top: pct(marker.y, height), width: 18, height: 18, marginLeft: -9, marginTop: -9, borderRadius: 9, borderWidth: 2, borderColor: color, backgroundColor: withAlpha(color, 0.3) }} />
  ) : (
    <View pointerEvents="none" style={{ position: 'absolute', left: pct(marker.x, width), top: pct(marker.y, height), width: pct(Math.max(marker.w, 6), width), height: pct(Math.max(marker.h, 6), height), borderWidth: 2, borderColor: color, backgroundColor: withAlpha(color, 0.15), borderRadius: 3 }} />
  )
}
