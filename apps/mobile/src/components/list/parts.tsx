/**
 * Pieces shared by the Routines, Pipeline and Memories lists — the mobile side of the desktop's
 * list pages: header, search, segment/tabs, state tile and pill, number cards, labels.
 * One place, so the three screens never drift into different shapes.
 */
import type { ComponentType, ReactNode } from 'react'
import { View, Text, Pressable, TextInput, ScrollView, StyleSheet } from 'react-native'
import { ArrowLeft, Loader2, Search } from 'lucide-react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { Spin } from '~/components/ui/spin'

const BLUE = '#3b82f6'
const EMERALD = '#10b981'

export type RowState = 'run' | 'bad' | 'ok' | 'warn' | 'idle'

export function useTokens() {
  return getThemeTokens(useThemeStore((s) => s.resolved))
}

export function toneColor(state: RowState, tokens: Record<string, string>): string {
  if (state === 'run') return BLUE
  if (state === 'bad') return tokens.destructive
  if (state === 'ok') return EMERALD
  if (state === 'warn') return '#f59e0b'
  return tokens.mutedForeground
}

/**
 * Tints a tone for a background, like `bg-blue-500/13` on the desktop. Hex gets a 2-digit alpha;
 * `hsl(...)` (the theme's destructive color) gets the same alpha through `hsla`. Anything else is
 * returned as is.
 */
export function tint(color: string, alpha = '26'): string {
  if (color.startsWith('#')) return `${color}${alpha}`
  const hsl = color.match(/^hsl\((.+)\)$/)
  if (hsl) return `hsla(${hsl[1]}, ${(parseInt(alpha, 16) / 255).toFixed(2)})`
  return color
}

export function ListHeader({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string
  subtitle?: string
  onBack: () => void
  right?: ReactNode
}) {
  const tokens = useTokens()
  return (
    <View style={[s.header, { borderBottomColor: tokens.border }]}>
      <Pressable onPress={onBack} style={s.iconBtn} accessibilityRole="button" hitSlop={4}>
        <ArrowLeft size={22} color={tokens.foreground} />
      </Pressable>
      <View style={{ minWidth: 0, flex: 1 }}>
        <Text style={[s.title, { color: tokens.foreground }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[s.subtitle, { color: tokens.mutedForeground }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  )
}

export function HeaderButton({ icon: Icon, label, onPress }: { icon: ComponentType<{ size?: number; color?: string }>; label: string; onPress: () => void }) {
  const tokens = useTokens()
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={({ pressed }) => [s.headerBtn, { backgroundColor: tokens.primary }, pressed && { opacity: 0.8 }]}
      accessibilityRole="button"
    >
      <Icon size={14} color={tokens.primaryForeground} />
      <Text style={[s.headerBtnText, { color: tokens.primaryForeground }]}>{label}</Text>
    </Pressable>
  )
}

export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const tokens = useTokens()
  return (
    <View style={[s.search, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <Search size={17} color={tokens.mutedForeground} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={tokens.mutedForeground}
        style={[s.searchInput, { color: tokens.foreground }]}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  )
}

/** Two or three icon segments, the active one lit (list / agenda, list / graph). */
export function Segment<K extends string>({
  items,
  value,
  onChange,
}: {
  items: { key: K; icon: ComponentType<{ size?: number; color?: string }>; label: string }[]
  value: K
  onChange: (key: K) => void
}) {
  const tokens = useTokens()
  return (
    <View style={[s.segment, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      {items.map(({ key, icon: Icon, label }) => (
        <Pressable
          key={key}
          onPress={() => onChange(key)}
          accessibilityLabel={label}
          accessibilityState={{ selected: value === key }}
          style={[s.segmentItem, value === key && { backgroundColor: tokens.muted }]}
        >
          <Icon size={18} color={value === key ? tokens.foreground : tokens.mutedForeground} />
        </Pressable>
      ))}
    </View>
  )
}

/** The page's own tabs: underline on the active one, count beside the label. */
export function PageTabs<K extends string>({
  items,
  value,
  onChange,
  scroll,
}: {
  items: { key: K; label: string; count?: number }[]
  value: K
  onChange: (key: K) => void
  /** Many tabs: the row scrolls sideways instead of squeezing them. */
  scroll?: boolean
}) {
  const tokens = useTokens()
  const Row = scroll ? ScrollView : View
  const rowProps = scroll
    ? { horizontal: true, showsHorizontalScrollIndicator: false, style: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: tokens.border }, contentContainerStyle: s.tabsRow }
    : { style: [s.tabs, { borderBottomColor: tokens.border }] }
  return (
    <Row {...(rowProps as object)}>
      {items.map((item) => {
        const active = item.key === value
        return (
          <Pressable key={item.key} onPress={() => onChange(item.key)} style={s.tab} accessibilityState={{ selected: active }}>
            <Text style={[s.tabText, { color: active ? tokens.foreground : tokens.mutedForeground }]}>{item.label}</Text>
            {item.count != null && (
              <View style={[s.tabCount, { backgroundColor: tokens.muted }]}>
                <Text style={{ fontSize: 11, color: tokens.mutedForeground }}>{item.count}</Text>
              </View>
            )}
            {active && <View style={[s.tabLine, { backgroundColor: tokens.primary }]} />}
          </Pressable>
        )
      })}
    </Row>
  )
}

export function StateTile({ state, icon: Icon, spinning }: { state: RowState; icon: ComponentType<{ size?: number; color?: string }>; spinning?: boolean }) {
  const tokens = useTokens()
  const color = toneColor(state, tokens)
  return (
    <View style={[s.tile, { backgroundColor: state === 'idle' ? tokens.muted : tint(color) }]}>
      {spinning ? (
        <Spin>
          <Loader2 size={17} color={color} />
        </Spin>
      ) : (
        <Icon size={17} color={color} />
      )}
    </View>
  )
}

export function StatePill({ state, label }: { state: RowState; label: string }) {
  const tokens = useTokens()
  const color = toneColor(state, tokens)
  const outlined = state !== 'idle'
  return (
    <View style={[s.pill, { borderColor: outlined ? tint(color, '66') : tokens.border }]}>
      <View style={[s.pillDot, { backgroundColor: state === 'idle' ? tokens.mutedForeground : color }]} />
      <Text style={{ fontSize: 11.5, color: outlined ? color : tokens.mutedForeground }}>{label}</Text>
    </View>
  )
}

export function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  const tokens = useTokens()
  return (
    <View style={[s.stat, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <Text numberOfLines={1} style={{ fontSize: 11.5, color: tokens.mutedForeground }}>
        {label}
      </Text>
      <Text style={{ marginTop: 2, fontSize: 18, fontWeight: '600', color: bad ? tokens.destructive : tokens.foreground }}>{value}</Text>
    </View>
  )
}

export function SectionLabel({ children }: { children: string }) {
  const tokens = useTokens()
  return <Text style={[s.label, { color: tokens.mutedForeground }]}>{children.toUpperCase()}</Text>
}

export function CountLine({ children }: { children: string }) {
  const tokens = useTokens()
  return <Text style={[s.count, { color: tokens.mutedForeground }]}>{children}</Text>
}

export function FootLine({ icon: Icon, text, aside }: { icon: ComponentType<{ size?: number; color?: string }>; text: string; aside?: string }) {
  const tokens = useTokens()
  return (
    <View style={[s.foot, { borderTopColor: tokens.border }]}>
      <Icon size={14} color={tokens.mutedForeground} />
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: tokens.mutedForeground }}>
        {text}
      </Text>
      {aside ? <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>{aside}</Text> : null}
    </View>
  )
}

/** A row of the list: tile, name + lines, the right column. Pressing opens it. */
export function ListRow({
  tile,
  title,
  lines,
  right,
  onPress,
  onLongPress,
}: {
  tile: ReactNode
  title: string
  lines: { text: string; quiet?: boolean; bad?: boolean }[]
  right?: ReactNode
  onPress: () => void
  /** Holding the row: gets the screen height of the finger, so a menu can open right there. */
  onLongPress?: (pageY: number) => void
}) {
  const tokens = useTokens()
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress ? (e) => onLongPress(e.nativeEvent.pageY) : undefined}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: tokens.accent }]}
    >
      {tile}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: tokens.foreground }}>
          {title}
        </Text>
        {lines.map((line, i) => (
          <Text
            key={i}
            numberOfLines={1}
            style={{
              marginTop: 2,
              fontSize: line.quiet ? 12 : 12.5,
              color: line.bad ? tokens.destructive : tokens.mutedForeground,
              opacity: line.quiet ? 0.8 : 1,
            }}
          >
            {line.text}
          </Text>
        ))}
      </View>
      {right ? <View style={{ alignItems: 'flex-end', gap: 6 }}>{right}</View> : null}
    </Pressable>
  )
}

const s = StyleSheet.create({
  tabsRow: { flexDirection: 'row', gap: 4, paddingHorizontal: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 12 },
  headerBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 34, borderRadius: 10, paddingHorizontal: 12, marginRight: 6 },
  headerBtnText: { fontSize: 13, fontWeight: '600' },
  search: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, height: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  segment: { flexDirection: 'row', padding: 2, borderRadius: 12, borderWidth: 1 },
  segmentItem: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', gap: 4, paddingHorizontal: 10, borderBottomWidth: 1 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 48, paddingHorizontal: 10 },
  tabText: { fontSize: 14, fontWeight: '500' },
  tabCount: { borderRadius: 99, paddingHorizontal: 7, paddingVertical: 1 },
  tabLine: { position: 'absolute', left: 8, right: 8, bottom: 0, height: 2, borderRadius: 2 },
  tile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, minWidth: 72, height: 24, paddingHorizontal: 9, borderRadius: 99, borderWidth: 1 },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  stat: { flex: 1, minWidth: 0, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 },
  label: { fontSize: 11, letterSpacing: 1, paddingHorizontal: 2, paddingBottom: 6 },
  count: { fontSize: 12, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 4, opacity: 0.85 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10, paddingVertical: 11, borderRadius: 14 },
})
