import type { ReactNode } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import Svg, { Polygon, Polyline } from 'react-native-svg'
import { ArrowDownRight, ArrowLeft, ArrowUpRight, ChevronRight } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useTokens } from '~/components/list/parts'
import { deltaPercent, type Metric, type SeriesPoint } from './usage-utils'

/** A block of the usage page: the app's card with an optional title row. */
export function UCard({ title, subtitle, action, children }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  const tokens = useTokens()
  return (
    <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      {title || action ? (
        <View style={s.cardHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {title ? <Text style={{ fontSize: 14.5, fontWeight: '600', color: tokens.foreground }}>{title}</Text> : null}
            {subtitle ? <Text style={{ marginTop: 1, fontSize: 11.5, color: tokens.mutedForeground }}>{subtitle}</Text> : null}
          </View>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  )
}

/** Small text segmented control (Hours | Tokens | Cost, Models | Projects…). */
export function TextSegment<K extends string>({ items, value, onChange }: { items: { key: K; label: string }[]; value: K; onChange: (key: K) => void }) {
  const tokens = useTokens()
  return (
    <View style={[s.segment, { borderColor: tokens.border, backgroundColor: tokens.background }]}>
      {items.map((item) => (
        <Pressable
          key={item.key}
          onPress={() => onChange(item.key)}
          accessibilityState={{ selected: value === item.key }}
          style={[s.segmentItem, value === item.key && { backgroundColor: tokens.muted }]}
        >
          <Text style={{ fontSize: 12.5, fontWeight: '500', color: value === item.key ? tokens.foreground : tokens.mutedForeground }}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

export function metricItems(t: (key: string) => string): { key: Metric; label: string }[] {
  return [
    { key: 'hours', label: t('usageScreen.metricHours') },
    { key: 'tokens', label: t('usageScreen.metricTokens') },
    { key: 'cost', label: t('usageScreen.metricCost') },
  ]
}

/** Change against the previous period. For the cost, going up is the bad direction. */
export function Delta({ current, previous, lowerIsBetter }: { current: number; previous: number | undefined; lowerIsBetter?: boolean }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const pct = deltaPercent(current, previous)
  if (pct === null) return <Text style={{ fontSize: 11.5, color: tokens.mutedForeground }}>{t('usageScreen.noComparison')}</Text>
  const up = pct >= 0
  const good = pct === 0 ? true : lowerIsBetter ? !up : up
  const color = good ? '#10b981' : tokens.destructive
  const Arrow = up ? ArrowUpRight : ArrowDownRight
  return (
    <View style={s.delta}>
      <Arrow size={12} color={color} />
      <Text style={{ fontSize: 11.5, fontWeight: '500', color, fontVariant: ['tabular-nums'] }}>
        {up ? '+' : '−'}
        {Math.abs(pct)}%
      </Text>
    </View>
  )
}

export function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null
  const w = 64
  const h = 28
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const points = values.map((v, i) => `${((i * w) / (values.length - 1)).toFixed(1)},${(h - 3 - ((v - min) / range) * (h - 6)).toFixed(1)}`).join(' ')
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <Polygon points={`0,${h} ${points} ${w},${h}`} fill={color} opacity={0.14} />
      <Polyline points={points} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  )
}

export function StatCard({ label, value, footer, spark, color }: { label: string; value: string; footer: ReactNode; spark?: number[]; color: string }) {
  const tokens = useTokens()
  return (
    <View style={[s.stat, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 11.5, color: tokens.mutedForeground }}>
          {label}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 19, fontWeight: '600', color: tokens.foreground, fontVariant: ['tabular-nums'] }}>
          {value}
        </Text>
        {footer}
      </View>
      {spark ? <Sparkline values={spark} color={color} /> : null}
    </View>
  )
}

/** The per-day bars: the peak in full color, the rest softer; the peak's value on top of it. */
export function DayBars({ points, metric, format, weekday, color = '#6ea8fe' }: { points: SeriesPoint[]; metric: Metric; format: (value: number) => string; weekday: (date: string) => string; color?: string }) {
  const tokens = useTokens()
  const max = Math.max(...points.map((p) => p.value), Number.EPSILON)
  const peak = points.findIndex((p) => p.value === max)
  const dense = points.length > 10
  const H = 120
  return (
    <View style={[s.bars, { gap: dense ? 2 : 8 }]} accessibilityLabel={metric}>
      {points.map((p, i) => {
        const isPeak = i === peak && max > 0
        const label = !dense || i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0 ? weekday(p.date) : ''
        return (
          <View key={p.date} style={s.barCol}>
            <View style={{ height: H, width: '100%', justifyContent: 'flex-end', alignItems: 'center' }}>
              {isPeak && !dense ? (
                <Text numberOfLines={1} style={{ position: 'absolute', top: 0, width: 96, textAlign: 'center', fontSize: 10.5, color: tokens.foreground }}>
                  {format(p.value)}
                </Text>
              ) : null}
              <View
                style={{
                  width: '100%',
                  maxWidth: dense ? undefined : 30,
                  height: Math.max(4, Math.round((p.value / max) * (H - (dense ? 0 : 16)))),
                  borderTopLeftRadius: dense ? 3 : 7,
                  borderTopRightRadius: dense ? 3 : 7,
                  borderBottomLeftRadius: 3,
                  borderBottomRightRadius: 3,
                  backgroundColor: color,
                  opacity: isPeak ? 1 : 0.5,
                }}
              />
            </View>
            <Text numberOfLines={1} style={{ fontSize: 11, color: tokens.mutedForeground, height: 14 }}>
              {label}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

/** A row of a ranking: name, share of the total as a bar, value. */
export function ShareRow({ name, sub, value, pct, color, last, leading, onPress }: { name: string; sub?: string; value: string; pct: number; color: string; last?: boolean; leading?: ReactNode; onPress?: () => void }) {
  const tokens = useTokens()
  const body = (
    <>
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View style={s.shareTop}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13.5, fontWeight: '500', color: tokens.foreground }}>
            {name}
          </Text>
          {sub ? (
            <Text numberOfLines={1} style={{ flexShrink: 0, fontSize: 11, color: tokens.mutedForeground }}>
              {sub}
            </Text>
          ) : null}
          <Text style={{ marginLeft: 'auto', fontSize: 11.5, color: tokens.mutedForeground, fontVariant: ['tabular-nums'] }}>{pct}%</Text>
        </View>
        <View style={[s.track, { backgroundColor: tokens.muted }]}>
          <View style={{ width: `${Math.max(pct, 2)}%`, height: '100%', borderRadius: 99, backgroundColor: color }} />
        </View>
      </View>
      <Text style={{ width: 76, textAlign: 'right', fontSize: 13, fontWeight: '600', color: tokens.foreground, fontVariant: ['tabular-nums'] }}>{value}</Text>
    </>
  )
  const style = [s.share, !last && { borderBottomWidth: 1, borderBottomColor: tokens.border }]
  return onPress ? (
    <Pressable onPress={onPress} style={style}>
      {body}
    </Pressable>
  ) : (
    <View style={style}>{body}</View>
  )
}

export function SeeAll({ label, onPress }: { label: string; onPress: () => void }) {
  const tokens = useTokens()
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={[s.seeAll, { borderColor: tokens.border }]}>
      <Text style={{ fontSize: 13, fontWeight: '500', color: tokens.foreground }}>{label}</Text>
      <ChevronRight size={14} color={tokens.mutedForeground} />
    </Pressable>
  )
}

export function Empty({ children }: { children: string }) {
  const tokens = useTokens()
  return <Text style={{ textAlign: 'center', padding: 28, fontSize: 13, color: tokens.mutedForeground }}>{children}</Text>
}

/** Row with a label and a value, separated by a line — the averages and the rhythm numbers. */
export function KeyRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const tokens = useTokens()
  return (
    <View style={[s.keyRow, !last && { borderBottomWidth: 1, borderBottomColor: tokens.border }]}>
      <Text style={{ flex: 1, fontSize: 12.5, color: tokens.mutedForeground }}>{label}</Text>
      <Text style={{ fontSize: 13, color: tokens.foreground, fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  )
}

/** The small number card of every section: label, value, a line of context. */
export function KpiCard({ label, value, meta, dense }: { label: string; value: string; meta?: string; dense?: boolean }) {
  const tokens = useTokens()
  return (
    <View style={[s.kpi, dense && { padding: 10 }, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <Text numberOfLines={1} style={{ fontSize: dense ? 11 : 11.5, color: tokens.mutedForeground }}>
        {label}
      </Text>
      <Text numberOfLines={1} style={{ fontSize: dense ? 15.5 : 19, fontWeight: '600', color: tokens.foreground, fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
      {meta ? (
        <Text numberOfLines={1} style={{ fontSize: dense ? 10.5 : 11, color: tokens.mutedForeground }}>
          {meta}
        </Text>
      ) : null}
    </View>
  )
}

/** KPI cards two per row (the page is narrow); an odd last card takes half the row. */
export function KpiGrid({ items, columns = 2 }: { items: { label: string; value: string; meta?: string }[]; columns?: 2 | 3 }) {
  const rows: (typeof items)[] = []
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns))
  return (
    <View style={{ gap: columns === 3 ? 6 : 8 }}>
      {rows.map((row) => (
        <View key={row[0].label} style={{ flexDirection: 'row', gap: columns === 3 ? 6 : 8 }}>
          {row.map((k) => (
            <KpiCard key={k.label} label={k.label} value={k.value} meta={k.meta} dense={columns === 3} />
          ))}
          {Array.from({ length: columns - row.length }, (_, i) => (
            <View key={`pad${i}`} style={{ flex: 1 }} />
          ))}
        </View>
      ))}
    </View>
  )
}

/** Top of a detail view: back to the list, with the name of what is open. */
export function BackBar({ label, title, subtitle, dot, right, onBack }: { label: string; title: string; subtitle?: string; dot?: string; right?: ReactNode; onBack: () => void }) {
  const tokens = useTokens()
  return (
    <View style={s.backBar}>
      <Pressable onPress={onBack} accessibilityRole="button" style={[s.backBtn, { borderColor: tokens.border }]}>
        <ArrowLeft size={14} color={tokens.foreground} />
        <Text style={{ fontSize: 13, fontWeight: '500', color: tokens.foreground }}>{label}</Text>
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {dot ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dot }} /> : null}
        <View style={{ flexShrink: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: '600', color: tokens.foreground }}>
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} style={{ fontSize: 11.5, color: tokens.mutedForeground }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {right}
    </View>
  )
}

/** Title and hint of a list, with its control on the right. */
export function ListIntro({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  const tokens = useTokens()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 2 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 14.5, fontWeight: '600', color: tokens.foreground }}>{title}</Text>
        {hint ? <Text style={{ marginTop: 1, fontSize: 11.5, lineHeight: 16, color: tokens.mutedForeground }}>{hint}</Text> : null}
      </View>
      {right}
    </View>
  )
}

const s = StyleSheet.create({
  kpi: { flex: 1, minWidth: 0, gap: 2, padding: 12, borderWidth: 1, borderRadius: 14 },
  backBar: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 11, borderWidth: 1, borderRadius: 10 },
  card: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  segment: { flexDirection: 'row', padding: 2, borderWidth: 1, borderRadius: 10 },
  segmentItem: { minWidth: 52, height: 32, paddingHorizontal: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  delta: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  stat: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-end', gap: 6, padding: 12, borderWidth: 1, borderRadius: 14 },
  bars: { flexDirection: 'row', alignItems: 'flex-end' },
  barCol: { flex: 1, alignItems: 'center', gap: 6, minWidth: 0 },
  share: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  shareTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  track: { height: 6, borderRadius: 99, overflow: 'hidden' },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 36, paddingLeft: 12, paddingRight: 8, borderWidth: 1, borderRadius: 10 },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9 },
})
