import { useEffect, useState, type MutableRefObject } from 'react'
import { View } from 'react-native'
import type { DictationLevels } from '~/hooks/useDictation'
import { levelsStale, visibleLevels } from '~/lib/dictation-logic'

const BARS = 36
const BAR_WIDTH = 3
const GAP = 3
const HEIGHT = 24
const FLOOR = 0.04
const TICK_MS = 70

/**
 * Live recording waveform: each microphone buffer enters on the right and slides left, like
 * the desktop's `dictation-wave`. Silence is drawn as dots. When no buffer has arrived
 * for a moment (metering unavailable) the bars give way to a calm row of pulsing dots, so
 * the user still sees that something is recording instead of a frozen wave.
 */
export function DictationWave({
  levels,
  color,
}: {
  levels: MutableRefObject<DictationLevels>
  color: string
}) {
  const [bars, setBars] = useState<number[]>(() => new Array<number>(BARS).fill(0))
  const [stale, setStale] = useState(false)
  const [pulse, setPulse] = useState(false)

  useEffect(() => {
    const id = setInterval(() => {
      const { values, at } = levels.current
      setBars(visibleLevels(values, BARS))
      const isStale = levelsStale(at, Date.now())
      setStale(isStale)
      if (isStale) setPulse((p) => !p)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [levels])

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: GAP, overflow: 'hidden' }}
    >
      {bars.map((level, i) => {
        const dot = stale || level < FLOOR
        return (
          <View
            key={i}
            style={{
              width: BAR_WIDTH,
              height: dot ? BAR_WIDTH : Math.max(BAR_WIDTH, level * (HEIGHT - 2)),
              borderRadius: BAR_WIDTH / 2,
              backgroundColor: color,
              opacity: dot ? (stale && pulse && i % 2 === 0 ? 0.7 : 0.4) : 0.9,
            }}
          />
        )
      })}
    </View>
  )
}
