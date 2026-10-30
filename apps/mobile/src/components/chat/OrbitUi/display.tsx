import { ScrollView, Text, View } from 'react-native'
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleCheck,
  Info,
  Minus,
  TriangleAlert,
} from 'lucide-react-native'
import { evalNumber, formatValue, type OrbitUiBlock } from '@orbit/shared'
import { withAlpha } from '~/lib/theme-tokens'
import { useText, useUi } from './context'
import { cardBg, panelBg, RADIUS, SUCCESS, useTokens, WARNING } from './style'

type Of<T extends OrbitUiBlock['type']> = Extract<OrbitUiBlock, { type: T }>

// ── stats ──────────────────────────────────────────────────────────────────

/**
 * Size of the number according to the length of the resolved text: the card is
 * half a screen wide, so "R$ 1.234.567,89" does not fit in the body of "R$ 12k".
 * Instead of cutting it, the font steps down one level per range — same as the desktop.
 */
function statSize(value: string): number {
  const n = value.length
  if (n <= 9) return 22
  if (n <= 13) return 19
  if (n <= 18) return 17
  return 15
}

export function Stats({ items }: Of<'stats'>) {
  const tx = useText()
  const tokens = useTokens()
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map((item, i) => {
        const Trend = item.trend === 'up' ? ArrowUpRight : item.trend === 'down' ? ArrowDownRight : Minus
        const trendColor =
          item.trend === 'up' ? SUCCESS : item.trend === 'down' ? tokens.destructive : tokens.mutedForeground
        return (
          <View
            key={i}
            style={{
              flexGrow: 1,
              flexBasis: 130,
              borderRadius: RADIUS,
              backgroundColor: cardBg(tokens),
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          >
            <Text style={{ fontSize: 11, color: tokens.mutedForeground }}>{tx(item.label)}</Text>
            <Text
              style={{
                marginTop: 2,
                fontSize: statSize(tx(item.value)),
                fontWeight: '600',
                letterSpacing: -0.3,
                color: tokens.foreground,
              }}
            >
              {tx(item.value)}
            </Text>
            {(item.delta || item.hint) && (
              <View style={{ marginTop: 4, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                {item.delta ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                    {item.trend ? <Trend size={11} color={trendColor} /> : null}
                    <Text style={{ fontSize: 11, fontWeight: '500', color: trendColor }}>{tx(item.delta)}</Text>
                  </View>
                ) : null}
                {item.hint ? (
                  <Text style={{ fontSize: 11, color: tokens.mutedForeground }}>{tx(item.hint)}</Text>
                ) : null}
              </View>
            )}
          </View>
        )
      })}
    </View>
  )
}

// ── callout ────────────────────────────────────────────────────────────────

const TONES = {
  info: { Icon: Info, color: 'muted' },
  success: { Icon: CircleCheck, color: SUCCESS },
  warning: { Icon: TriangleAlert, color: WARNING },
  danger: { Icon: CircleAlert, color: 'destructive' },
} as const

export function Callout({ tone, title, text }: Of<'callout'>) {
  const tx = useText()
  const tokens = useTokens()
  const { Icon, color } = TONES[tone]
  const accent = color === 'muted' ? tokens.mutedForeground : color === 'destructive' ? tokens.destructive : color
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 10,
        borderRadius: RADIUS,
        backgroundColor: color === 'muted' ? withAlpha(tokens.secondary, 0.7) : withAlpha(accent, 0.12),
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <Icon size={15} color={accent} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        {title ? (
          <Text style={{ fontSize: 13, fontWeight: '600', color: tokens.foreground }}>{tx(title)}</Text>
        ) : null}
        <Text style={{ fontSize: 13, lineHeight: 19, color: tokens.foreground, opacity: 0.9 }}>{tx(text)}</Text>
      </View>
    </View>
  )
}

// ── steps ──────────────────────────────────────────────────────────────────

export function Steps({ items }: Of<'steps'>) {
  const tx = useText()
  const tokens = useTokens()
  return (
    <View>
      {items.map((item, i) => {
        const status = item.status ?? 'todo'
        const last = i === items.length - 1
        const filled = status === 'done'
        const active = status === 'active'
        return (
          <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ alignItems: 'center' }}>
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: filled
                    ? tokens.primary
                    : active
                      ? withAlpha(tokens.primary, 0.2)
                      : withAlpha(tokens.secondary, 0.9),
                  borderWidth: active ? 2 : 0,
                  borderColor: active ? tokens.primary : undefined,
                }}
              >
                {filled ? (
                  <Check size={12} color={tokens.primaryForeground} />
                ) : (
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: '600',
                      color: active ? tokens.foreground : tokens.mutedForeground,
                    }}
                  >
                    {i + 1}
                  </Text>
                )}
              </View>
              {!last ? (
                <View style={{ width: 1, flex: 1, marginVertical: 3, backgroundColor: tokens.border }} />
              ) : null}
            </View>
            <View style={{ flex: 1, minWidth: 0, paddingTop: 1, paddingBottom: last ? 0 : 12 }}>
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: '500',
                  color: status === 'todo' ? tokens.mutedForeground : tokens.foreground,
                }}
              >
                {tx(item.title)}
              </Text>
              {item.text ? (
                <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 17, color: tokens.mutedForeground }}>
                  {tx(item.text)}
                </Text>
              ) : null}
            </View>
          </View>
        )
      })}
    </View>
  )
}

// ── table ──────────────────────────────────────────────────────────────────

/** Table of the block. Cells with a minimum width and horizontal scroll: with 5
 *  columns on a phone, squeezing everything into `flex: 1` would leave the text illegible. */
export function DataTable({ columns, rows }: Of<'table'>) {
  const tx = useText()
  const tokens = useTokens()
  const cellStyle = {
    minWidth: 84,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRightWidth: 1,
    borderColor: tokens.border,
  } as const
  return (
    <View style={{ borderRadius: RADIUS, overflow: 'hidden', backgroundColor: panelBg(tokens) }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
        <View>
          <View style={{ flexDirection: 'row' }}>
            {columns.map((column, i) => (
              <View
                key={i}
                style={[cellStyle, { borderRightWidth: i < columns.length - 1 ? 1 : 0 }]}
              >
                <Text style={{ fontSize: 11, fontWeight: '600', color: tokens.mutedForeground }}>
                  {tx(column)}
                </Text>
              </View>
            ))}
          </View>
          {rows.map((row, r) => (
            <View
              key={r}
              style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: tokens.border }}
            >
              {columns.map((_, c) => (
                <View key={c} style={[cellStyle, { borderRightWidth: c < columns.length - 1 ? 1 : 0 }]}>
                  <Text style={{ fontSize: 12, color: tokens.foreground }}>{tx(row[c] ?? '')}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

// ── checklist ──────────────────────────────────────────────────────────────

export function Checklist({ items }: Of<'checklist'>) {
  const tx = useText()
  const tokens = useTokens()
  return (
    <View style={{ gap: 6 }}>
      {items.map((item, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View
            style={{
              marginTop: 1,
              width: 16,
              height: 16,
              borderRadius: 4,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: item.done ? tokens.primary : withAlpha(tokens.secondary, 0.9),
            }}
          >
            {item.done ? <Check size={11} color={tokens.primaryForeground} /> : null}
          </View>
          <Text
            style={{
              flex: 1,
              fontSize: 13,
              lineHeight: 19,
              color: item.done ? tokens.mutedForeground : tokens.foreground,
              textDecorationLine: item.done ? 'line-through' : undefined,
            }}
          >
            {tx(item.text)}
          </Text>
        </View>
      ))}
    </View>
  )
}

// ── compare ────────────────────────────────────────────────────────────────

export function Compare({ items }: Of<'compare'>) {
  const tx = useText()
  const tokens = useTokens()
  return (
    <View style={{ gap: 8 }}>
      {items.map((item, i) => (
        <View
          key={i}
          style={{
            borderRadius: RADIUS,
            backgroundColor: cardBg(tokens),
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Text style={{ flexShrink: 1, fontSize: 13, fontWeight: '600', color: tokens.foreground }}>
              {tx(item.title)}
            </Text>
            {item.tag ? (
              <View
                style={{
                  borderRadius: 999,
                  backgroundColor: withAlpha(tokens.primary, 0.2),
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: '500', color: tokens.foreground }}>{tx(item.tag)}</Text>
              </View>
            ) : null}
          </View>
          <View style={{ marginTop: 6, gap: 5 }}>
            {item.points.map((point, p) => (
              <View key={p} style={{ flexDirection: 'row', gap: 7 }}>
                <Check size={13} color={tokens.mutedForeground} style={{ marginTop: 2 }} />
                <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: tokens.foreground }}>{tx(point)}</Text>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  )
}

// ── kv ─────────────────────────────────────────────────────────────────────

export function KeyValue({ items }: Of<'kv'>) {
  const tx = useText()
  const tokens = useTokens()
  return (
    <View
      style={{
        borderRadius: RADIUS,
        backgroundColor: panelBg(tokens),
        paddingHorizontal: 12,
        paddingVertical: 4,
      }}
    >
      {items.map((item, i) => (
        <View
          key={i}
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            gap: 16,
            paddingVertical: 6,
            borderTopWidth: i > 0 ? 1 : 0,
            borderColor: tokens.border,
          }}
        >
          <Text style={{ flexShrink: 1, fontSize: 13, color: tokens.mutedForeground }}>{tx(item.label)}</Text>
          <Text style={{ fontSize: 13, fontWeight: '600', textAlign: 'right', color: tokens.foreground }}>
            {tx(item.value)}
          </Text>
        </View>
      ))}
    </View>
  )
}

// ── progress ───────────────────────────────────────────────────────────────

export function Progress({ items }: Of<'progress'>) {
  const { scope, locale } = useUi()
  const tx = useText()
  const tokens = useTokens()
  return (
    <View style={{ gap: 12 }}>
      {items.map((item, i) => {
        const raw = evalNumber(item.value, scope)
        const value = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0
        return (
          <View key={i}>
            <View
              style={{
                marginBottom: 5,
                flexDirection: 'row',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: tokens.foreground }}>
                {tx(item.label)}
              </Text>
              <Text style={{ fontSize: 11, color: tokens.mutedForeground }}>
                {item.hint ? tx(item.hint) : `${formatValue(value, '0', locale)}%`}
              </Text>
            </View>
            <View
              style={{ height: 7, borderRadius: 999, overflow: 'hidden', backgroundColor: withAlpha(tokens.secondary, 0.95) }}
            >
              <View
                style={{
                  width: `${value}%`,
                  height: '100%',
                  borderRadius: 999,
                  backgroundColor: tokens.primary,
                }}
              />
            </View>
          </View>
        )
      })}
    </View>
  )
}
