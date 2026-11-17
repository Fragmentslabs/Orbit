import { useEffect, useState, type MutableRefObject } from 'react'
import { Text, TouchableOpacity, View } from 'react-native'
import { Hand } from 'lucide-react-native'

import type { DictationLevels } from '~/hooks/useDictation'
import type { CallPhase } from '~/hooks/useVoiceCall'
import { DictationWave } from './DictationWave'

const BARS = 36
const BAR_WIDTH = 3
const GAP = 3
const HEIGHT = 24
const TICK_MS = 90

/**
 * Bars for the phases the microphone is not involved in: lively while the agent speaks (the
 * level is made up, the phone has no loudness of the playing audio), and a slow wave of dots
 * running through the row while it thinks.
 */
function ActivityBars({ phase, color }: { phase: Exclude<CallPhase, 'listening'>; color: string }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: GAP, overflow: 'hidden' }}
    >
      {Array.from({ length: BARS }, (_, i) => {
        if (phase === 'thinking') {
          // One crest travelling left to right, the rest are dots.
          const crest = Math.max(0, 1 - Math.abs(((tick * 0.6) % (BARS + 8)) - 4 - i) / 4)
          const h = BAR_WIDTH + crest * 10
          return (
            <View
              key={i}
              style={{ width: BAR_WIDTH, height: h, borderRadius: BAR_WIDTH / 2, backgroundColor: color, opacity: 0.35 + crest * 0.5 }}
            />
          )
        }
        // Speaking: each bar moves on its own phase, with a swell in the middle.
        const swell = 0.35 + 0.65 * Math.sin((Math.PI * (i + 1)) / (BARS + 1))
        const wobble = 0.5 + 0.5 * Math.sin(tick * 0.9 + i * 1.7) * Math.sin(tick * 0.37 + i * 0.6)
        const h = Math.max(BAR_WIDTH, (HEIGHT - 2) * swell * (0.25 + 0.75 * Math.abs(wobble)))
        return <View key={i} style={{ width: BAR_WIDTH, height: h, borderRadius: BAR_WIDTH / 2, backgroundColor: color, opacity: 0.9 }} />
      })}
    </View>
  )
}

/**
 * What the call shows where the placeholder sits: the status ("Listening", "Thinking",
 * "Speaking"), the bars (the microphone while listening, the speech while the agent talks) and the
 * interrupt button once the turn is on the agent's side. Laid over the field, which stays
 * mounted but inert for the duration of the call.
 */
export function CallStrip({
  phase,
  levels,
  label,
  color,
  background,
  interruptLabel,
  onInterrupt,
}: {
  phase: CallPhase
  levels: MutableRefObject<DictationLevels>
  label: string
  color: string
  background: string
  interruptLabel: string
  onInterrupt: () => void
}) {
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: background,
      }}
    >
      <Text numberOfLines={1} style={{ color, fontSize: 16, flexShrink: 0 }}>
        {label}
      </Text>
      <View style={{ flex: 1 }}>
        {phase === 'listening' ? <DictationWave levels={levels} color={color} /> : <ActivityBars phase={phase} color={color} />}
      </View>
      {phase !== 'listening' && (
        <TouchableOpacity onPress={onInterrupt} activeOpacity={0.7} hitSlop={8} accessibilityLabel={interruptLabel}>
          <Hand size={18} color={color} />
        </TouchableOpacity>
      )}
    </View>
  )
}
