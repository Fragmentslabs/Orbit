import { useMemo, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import Svg, { Circle, Path, Polyline, Text as SvgText } from 'react-native-svg'
import {
  evalNumber,
  formatValue,
  sampleFn,
  type OrbitUiBlock,
  type Scope,
} from '@orbit/shared'
import { useText, useUi } from './context'
import { panelBg, useTokens } from './style'

type Of<T extends OrbitUiBlock['type']> = Extract<OrbitUiBlock, { type: T }>

/**
 * Chart of the `orbit-ui` blocks, drawn with what the app already has: bars in
 * `View`s and line/area/pie in `react-native-svg` (which lucide and
 * ContextMeter already use — no chart library is added).
 *
 * The data are the same two sources as the desktop: ready points (`data`) or
 * functions sampled in `x` (`fns` + `x` + `steps`). A value that does not evaluate becomes
 * a hole in the series, and a whole invalid series falls back to the value table — a
 * blank chart would hide the number the answer meant to show.
 */

const SERIES = ['#f2b705', '#5b8def', '#37a169', '#c26bd8', '#e2725b', '#8a8f98']
const BAR_MAX_HEIGHT = 116

type ChartRow = { label: string; values: (number | null)[] }

function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null
}

function chartRows(block: Of<'chart'>, scope: Scope, tx: (s: string | undefined) => string): {
  rows: ChartRow[]
  keys: { name: string }[]
} {
  if (block.data) {
    return {
      rows: block.data.map((d) => ({ label: tx(d.label), values: [finite(evalNumber(d.value, scope))] })),
      keys: [{ name: tx(block.title) }],
    }
  }
  const [from, to] = block.x!
  const fns = block.fns!
  const series = fns.map((f) => sampleFn(f.fn, from, to, block.steps ?? 24, scope))
  return {
    rows: series[0].map((point, i) => ({
      label: formatValue(point.x),
      values: series.map((points) => finite(points[i].y)),
    })),
    keys: fns.map((f, j) => ({ name: tx(f.name) || `#${j + 1}` })),
  }
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Every value of a column is invalid: there is nothing to draw. */
function isEmpty(rows: ChartRow[]): boolean {
  return rows.every((row) => row.values.every((v) => v === null)) || rows.length === 0
}

function Legend({ keys, showValues }: { keys: { name: string }[]; showValues?: boolean }) {
  const tokens = useTokens()
  if (keys.length < 2 || !showValues) return null
  return (
    <View style={{ marginTop: 6, flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 }}>
      {keys.map((key, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: SERIES[i % SERIES.length] }} />
          <Text style={{ fontSize: 11, color: tokens.mutedForeground }}>{key.name}</Text>
        </View>
      ))}
    </View>
  )
}

/** Last resort: the numbers as text, so the block does not become an empty rectangle. */
function ValuesTable({ rows, keys }: { rows: ChartRow[]; keys: { name: string }[] }) {
  const tokens = useTokens()
  return (
    <View style={{ gap: 3 }}>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
          <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>{row.label}</Text>
          <Text style={{ fontSize: 12, color: tokens.foreground }}>
            {row.values
              .map((v, j) => `${keys.length > 1 ? `${keys[j].name}: ` : ''}${v === null ? '—' : formatValue(v)}`)
              .join('  ·  ')}
          </Text>
        </View>
      ))}
    </View>
  )
}

function Bars({ rows, keys, unit }: { rows: ChartRow[]; keys: { name: string }[]; unit?: string }) {
  const tokens = useTokens()
  const max = Math.max(1, ...rows.flatMap((row) => row.values.map(num)))
  const multi = keys.length > 1
  const barWidth = multi ? 9 : rows.length > 8 ? 16 : 26
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12 }}>
          {rows.map((row, i) => (
            <View key={i} style={{ alignItems: 'center', gap: 5 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: BAR_MAX_HEIGHT }}>
                {row.values.map((value, j) => {
                  const height = value === null ? 2 : Math.max(2, (num(value) / max) * BAR_MAX_HEIGHT)
                  return (
                    <View key={j} style={{ alignItems: 'center', justifyContent: 'flex-end' }}>
                      {!multi && rows.length <= 8 && value !== null ? (
                        <Text style={{ fontSize: 9, color: tokens.mutedForeground, marginBottom: 2 }}>
                          {formatValue(value)}
                        </Text>
                      ) : null}
                      <View
                        style={{
                          width: barWidth,
                          height,
                          borderTopLeftRadius: 4,
                          borderTopRightRadius: 4,
                          backgroundColor: value === null ? tokens.border : SERIES[j % SERIES.length],
                        }}
                      />
                    </View>
                  )
                })}
              </View>
              <Text style={{ fontSize: 10, color: tokens.mutedForeground, maxWidth: 64 }} numberOfLines={1}>
                {row.label}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
      {unit ? (
        <Text style={{ marginTop: 5, fontSize: 10, color: tokens.mutedForeground }} numberOfLines={1}>
          {unit}
        </Text>
      ) : null}
      <Legend keys={keys} showValues />
    </View>
  )
}

function Lines({
  rows,
  keys,
  area,
  xLabel,
}: {
  rows: ChartRow[]
  keys: { name: string }[]
  area: boolean
  xLabel?: string
}) {
  const tokens = useTokens()
  const [width, setWidth] = useState(0)
  const height = 130
  const all = rows.flatMap((row) => row.values.filter((v): v is number => v !== null))
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || 1
  const x = (i: number) => (rows.length <= 1 ? 0 : (i / (rows.length - 1)) * (width - 8) + 4)
  const y = (v: number) => height - 8 - ((v - min) / span) * (height - 20)

  /** Continuous stretches of valid values: a hole in the series does not connect points
   *  that do not exist. */
  const runs = (series: (number | null)[]): [number, number][][] => {
    const out: [number, number][][] = []
    let current: [number, number][] = []
    series.forEach((value, i) => {
      if (value === null) {
        if (current.length > 1) out.push(current)
        current = []
      } else {
        current.push([x(i), y(value)])
      }
    })
    if (current.length > 1) out.push(current)
    return out
  }

  return (
    <View>
      <View style={{ height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 ? (
          <Svg width={width} height={height}>
            {[0, 0.5, 1].map((t) => (
              <Path
                key={t}
                d={`M 0 ${y(min + span * t)} L ${width} ${y(min + span * t)}`}
                stroke={tokens.border}
                strokeWidth={1}
              />
            ))}
            {keys.map((_, j) =>
              runs(rows.map((row) => row.values[j] ?? null)).map((points, r) => {
                const line = points.map((p) => `${p[0]},${p[1]}`).join(' ')
                return area ? (
                  <Path
                    key={`${j}-${r}`}
                    d={`M ${points[0][0]} ${height} L ${line.replace(/ /g, ' L ')} L ${points[points.length - 1][0]} ${height} Z`}
                    fill={SERIES[j % SERIES.length]}
                    fillOpacity={0.16}
                  />
                ) : (
                  <Polyline
                    key={`${j}-${r}`}
                    points={line}
                    fill="none"
                    stroke={SERIES[j % SERIES.length]}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )
              }),
            )}
            {keys.map((_, j) =>
              area
                ? runs(rows.map((row) => row.values[j] ?? null)).map((points, r) => (
                    <Polyline
                      key={`a-${j}-${r}`}
                      points={points.map((p) => `${p[0]},${p[1]}`).join(' ')}
                      fill="none"
                      stroke={SERIES[j % SERIES.length]}
                      strokeWidth={2}
                    />
                  ))
                : null,
            )}
            <SvgText x={2} y={10} fontSize={9} fill={tokens.mutedForeground}>
              {formatValue(max, 'compact')}
            </SvgText>
            <SvgText x={2} y={height - 2} fontSize={9} fill={tokens.mutedForeground}>
              {formatValue(min, 'compact')}
            </SvgText>
          </Svg>
        ) : null}
      </View>
      <View style={{ marginTop: 2, flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 10, color: tokens.mutedForeground }}>{rows[0]?.label}</Text>
        {xLabel ? (
          <Text style={{ fontSize: 10, color: tokens.mutedForeground }}>{xLabel}</Text>
        ) : null}
        <Text style={{ fontSize: 10, color: tokens.mutedForeground }}>{rows[rows.length - 1]?.label}</Text>
      </View>
      <Legend keys={keys} showValues />
    </View>
  )
}

function Donut({ rows, unit }: { rows: ChartRow[]; unit?: string }) {
  const tokens = useTokens()
  const total = rows.reduce((sum, row) => sum + Math.max(0, num(row.values[0])), 0)
  const radius = 46
  const stroke = 16
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <View>
      <View style={{ alignItems: 'center' }}>
        <Svg width={radius * 2 + stroke} height={radius * 2 + stroke}>
          <Circle
            cx={radius + stroke / 2}
            cy={radius + stroke / 2}
            r={radius}
            stroke={tokens.border}
            strokeWidth={stroke}
            fill="none"
          />
          {total > 0
            ? rows.map((row, i) => {
                const value = Math.max(0, num(row.values[0]))
                const length = (value / total) * circumference
                const dash = `${length} ${circumference - length}`
                const dashOffset = -offset
                offset += length
                return (
                  <Circle
                    key={i}
                    cx={radius + stroke / 2}
                    cy={radius + stroke / 2}
                    r={radius}
                    stroke={SERIES[i % SERIES.length]}
                    strokeWidth={stroke}
                    strokeDasharray={dash}
                    strokeDashoffset={dashOffset}
                    fill="none"
                    rotation={-90}
                    originX={radius + stroke / 2}
                    originY={radius + stroke / 2}
                  />
                )
              })
            : null}
        </Svg>
      </View>
      <View style={{ marginTop: 8, gap: 3 }}>
        {rows.map((row, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: SERIES[i % SERIES.length] }} />
            <Text style={{ flex: 1, fontSize: 11, color: tokens.mutedForeground }} numberOfLines={1}>
              {row.label}
            </Text>
            <Text style={{ fontSize: 11, color: tokens.foreground }}>
              {row.values[0] === null ? '—' : `${formatValue(row.values[0])}${unit ? ` ${unit}` : ''}`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  )
}

export function Chart(block: Of<'chart'>) {
  const { scope } = useUi()
  const tokens = useTokens()
  const tx = useText()
  const { kind, title, unit, xLabel } = block
  const { rows, keys } = useMemo(() => chartRows(block, scope, tx), [block, scope, tx])

  return (
    <View style={{ borderRadius: 12, backgroundColor: panelBg(tokens), paddingHorizontal: 12, paddingVertical: 10 }}>
      {title ? (
        <Text style={{ marginBottom: 8, fontSize: 13, fontWeight: '600', color: tokens.foreground }}>{title}</Text>
      ) : null}
      {isEmpty(rows) ? (
        <ValuesTable rows={rows} keys={keys} />
      ) : kind === 'pie' ? (
        <Donut rows={rows} unit={unit} />
      ) : kind === 'line' || kind === 'area' ? (
        <Lines rows={rows} keys={keys} area={kind === 'area'} xLabel={xLabel} />
      ) : (
        <Bars rows={rows} keys={keys} unit={unit} />
      )}
    </View>
  )
}
