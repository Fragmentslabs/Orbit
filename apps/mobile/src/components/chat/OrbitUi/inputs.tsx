import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput as RNTextInput,
  View,
} from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import * as Clipboard from 'expo-clipboard'
import { Check, Copy, Send } from 'lucide-react-native'
import { formatValue, type OrbitUiBlock, type Value } from '@orbit/shared'
import { withAlpha } from '~/lib/theme-tokens'
import { useText, useUi } from './context'
import { fieldBg, useTokens } from './style'

type Of<T extends OrbitUiBlock['type']> = Extract<OrbitUiBlock, { type: T }>

/** Label on top, current value on the right — the same `Field` as the desktop. */
export function Field({ label, aside, children }: { label?: string; aside?: string; children: ReactNode }) {
  const tokens = useTokens()
  return (
    <View style={{ flexGrow: 1, flexBasis: 180, gap: 6 }}>
      {label || aside ? (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          {label ? (
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 11, color: tokens.mutedForeground }}>
              {label}
            </Text>
          ) : (
            <View />
          )}
          {aside ? (
            <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.foreground }}>{aside}</Text>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  )
}

/** Value of an input: the state of the fence, with the block default when the
 *  user has not touched it yet. */
function useInput<T extends Value>(id: string, fallback: T) {
  const { scope, setValue } = useUi()
  const value = (Object.hasOwn(scope, id) ? scope[id] : fallback) as T
  return [value, (v: Value) => setValue(id, v)] as const
}

const INPUT_STYLE = { height: 36, borderRadius: 8, paddingHorizontal: 10, fontSize: 13 } as const

// ── slider ─────────────────────────────────────────────────────────────────

/**
 * Slider without a new dependency: RN does not ship a slider in the core (and the
 * @rn-primitives one only responds to screen-reader gestures, not to dragging).
 *
 * The drag is a native pan gesture: the thumb and the fill follow the finger on the
 * UI thread (Reanimated), while the fence state is written at ~30 Hz. The formulas
 * and the chart keep up during the drag without a React render per touch frame —
 * that split is what keeps the thumb smooth even on a fence with a chart.
 */
export function SliderInput(block: Of<'slider'>) {
  const tx = useText()
  const tokens = useTokens()
  const { locale, setValue } = useUi()
  const [value] = useInput<number>(block.id, block.value ?? block.min)
  const span = block.max - block.min
  const step =
    block.step && block.step > 0
      ? block.step
      : Number.isInteger(block.min) && Number.isInteger(block.max)
        ? 1
        : span / 100
  const safeStep = step > 0 ? step : 1

  const width = useSharedValue(0)
  const thumbX = useSharedValue(0)
  const dragging = useSharedValue(false)
  const lastSent = useSharedValue(0)

  const commit = useCallback((next: number) => setValue(block.id, next), [block.id, setValue])

  const gesture = useMemo(() => {
    /** Finger position → snapped value, without crossing to JS. */
    const apply = (x: number, force = false) => {
      'worklet'
      const w = width.get()
      if (w <= 0) return
      const clamped = Math.min(w, Math.max(0, x))
      thumbX.set(clamped)
      let next = block.min
      if (span > 0) {
        const ratio = clamped / w
        const snapped = Math.round((block.min + ratio * span) / safeStep) * safeStep
        next = Number(Math.min(block.max, Math.max(block.min, snapped)).toFixed(6))
      }
      // eslint-disable-next-line react-hooks/purity -- this runs in a worklet on the UI thread, not during render
      const now = Date.now()
      if (force || now - lastSent.get() >= 32) {
        lastSent.set(now)
        runOnJS(commit)(next)
      }
    }

    const pan = Gesture.Pan()
      .maxPointers(1)
      .activeOffsetX([-3, 3])
      .failOffsetY([-20, 20])
      .onStart((e) => {
        'worklet'
        dragging.set(true)
        apply(e.x, true)
      })
      .onUpdate((e) => {
        'worklet'
        apply(e.x)
      })
      .onEnd((e) => {
        'worklet'
        apply(e.x, true)
        dragging.set(false)
      })
      .onFinalize(() => {
        'worklet'
        dragging.set(false)
      })

    // Tapping the track sets the value too; it only wins when the finger did not drag.
    const tap = Gesture.Tap()
      .maxDistance(8)
      .onEnd((e, success) => {
        'worklet'
        if (!success) return
        apply(e.x, true)
      })

    return Gesture.Race(pan, tap)
  }, [block.min, block.max, span, safeStep, width, thumbX, dragging, lastSent, commit])

  const thumb = 18

  const fillStyle = useAnimatedStyle(() => {
    const w = width.get()
    return {
      transform: [{ scaleX: w > 0 ? Math.max(0, Math.min(1, thumbX.get() / w)) : 0 }],
    }
  }, [])

  const thumbStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: thumbX.get() - thumb / 2 }] }),
    [],
  )

  // The value can also change from outside (a `set` button, a default): put the
  // thumb there — except while the finger owns it.
  useEffect(() => {
    if (dragging.get() || span <= 0) return
    const w = width.get()
    if (w <= 0) return
    const ratio = Math.min(1, Math.max(0, (Number(value) - block.min) / span))
    thumbX.set(ratio * w)
  }, [value, span, block.min, dragging, thumbX, width])

  return (
    <Field
      label={tx(block.label)}
      aside={`${formatValue(Number(value), undefined, locale)}${block.unit ? ` ${block.unit}` : ''}`}
    >
      <GestureDetector gesture={gesture}>
        <View
          accessibilityRole="adjustable"
          accessibilityLabel={block.label}
          accessibilityValue={{ min: block.min, max: block.max, now: Number(value) }}
          style={{ height: 32, justifyContent: 'center', marginHorizontal: thumb / 2 }}
          onLayout={(e) => {
            const next = e.nativeEvent.layout.width
            width.set(next)
            if (!dragging.get() && span > 0) {
              const ratio = Math.min(1, Math.max(0, (Number(value) - block.min) / span))
              thumbX.set(ratio * next)
            }
          }}
        >
          <View style={{ height: 6, borderRadius: 999, backgroundColor: tokens.secondary, overflow: 'hidden' }}>
            <Animated.View
              style={[
                {
                  width: '100%',
                  height: '100%',
                  backgroundColor: tokens.primary,
                  transformOrigin: 'left center',
                },
                fillStyle,
              ]}
            />
          </View>
          <Animated.View
            style={[
              {
                position: 'absolute',
                left: 0,
                top: (32 - thumb) / 2,
                width: thumb,
                height: thumb,
                borderRadius: thumb / 2,
                backgroundColor: tokens.primary,
                borderWidth: 3,
                borderColor: tokens.background,
                pointerEvents: 'none',
              },
              thumbStyle,
            ]}
          />
        </View>
      </GestureDetector>
    </Field>
  )
}

// ── number ─────────────────────────────────────────────────────────────────

export function NumberInput(block: Of<'number'>) {
  const tx = useText()
  const tokens = useTokens()
  const [value, set] = useInput<number>(block.id, block.value)
  // Text draft while the field is focused: "1." and "-" are legitimate
  // states of someone typing and would not survive a controlled numeric value
  // (same reason as the desktop). Outside the focus, the value rules — including
  // when another block rewrites it (`action: "set"`).
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <Field label={tx(block.label)} aside={block.unit}>
      <RNTextInput
        keyboardType="decimal-pad"
        value={draft ?? String(value)}
        accessibilityLabel={block.label}
        placeholderTextColor={tokens.mutedForeground}
        onBlur={() => setDraft(null)}
        onChangeText={(next) => {
          setDraft(next)
          const parsed = Number(next.replace(',', '.'))
          if (next !== '' && Number.isFinite(parsed)) set(parsed)
        }}
        style={{ ...INPUT_STYLE, backgroundColor: fieldBg(tokens), color: tokens.foreground }}
      />
    </Field>
  )
}

// ── select ─────────────────────────────────────────────────────────────────

/**
 * Select as a line of tappable options, instead of a modal picker: the phone has no
 * `<select>`, and with up to 12 options the chosen value needs to stay
 * visible while the rest of the answer reacts to it.
 */
export function SelectInput(block: Of<'select'>) {
  const tx = useText()
  const tokens = useTokens()
  const [value, set] = useInput<Value>(block.id, block.value ?? block.options[0].value)
  return (
    <Field label={tx(block.label)}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {block.options.map((option, i) => {
          const active = option.value === value
          return (
            <Pressable
              key={`${String(option.value)}-${i}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={tx(option.label)}
              onPress={() => set(option.value)}
              style={{
                borderRadius: 999,
                paddingHorizontal: 10,
                paddingVertical: 5,
                backgroundColor: active ? withAlpha(tokens.primary, 0.22) : fieldBg(tokens),
                borderWidth: 1,
                borderColor: active ? tokens.primary : 'transparent',
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: active ? '600' : '400', color: tokens.foreground }}>
                {tx(option.label)}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </Field>
  )
}

// ── tabs ───────────────────────────────────────────────────────────────────

export function Tabs(block: Of<'tabs'>) {
  const { options, id } = block
  const tx = useText()
  const tokens = useTokens()
  const [value, set] = useInput<Value>(id, block.value ?? options[0].value)
  return (
    <View accessibilityRole="tablist">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
        <View
          style={{
            flexDirection: 'row',
            gap: 2,
            borderRadius: 999,
            padding: 2,
            backgroundColor: tokens.secondary,
          }}
        >
          {options.map((option, i) => {
            const active = option.value === value
            return (
              <Pressable
                key={`${String(option.value)}-${i}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => set(option.value)}
                style={{
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 4,
                  backgroundColor: active ? tokens.background : 'transparent',
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: '500',
                    color: active ? tokens.foreground : tokens.mutedForeground,
                  }}
                >
                  {tx(option.label)}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </ScrollView>
    </View>
  )
}

// ── toggle ─────────────────────────────────────────────────────────────────

export function ToggleInput(block: Of<'toggle'>) {
  const tx = useText()
  const tokens = useTokens()
  const [value, set] = useInput(block.id, block.value ?? false)
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: Boolean(value) }}
      accessibilityLabel={tx(block.label)}
      onPress={() => set(!value)}
      style={{
        flexGrow: 1,
        flexBasis: 180,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        borderRadius: 8,
        backgroundColor: withAlpha(tokens.secondary, 0.7),
        paddingHorizontal: 12,
        paddingVertical: 8,
      }}
    >
      <Text style={{ flexShrink: 1, fontSize: 13, color: tokens.foreground }}>{tx(block.label)}</Text>
      {/* The switch is only the drawing: what receives the touch is the whole row. Without
          that, tapping the switch itself would fire both handlers and the value
          would go back to what it was. */}
      <View style={{ pointerEvents: 'none' }}>
        <Switch
          value={Boolean(value)}
          trackColor={{ true: tokens.primary, false: withAlpha(tokens.mutedForeground, 0.4) }}
          thumbColor={tokens.background}
        />
      </View>
    </Pressable>
  )
}

// ── text ───────────────────────────────────────────────────────────────────

export function TextInputBlock(block: Of<'text'>) {
  const tx = useText()
  const tokens = useTokens()
  const [value, set] = useInput(block.id, block.value ?? '')
  return (
    <Field label={tx(block.label)}>
      <RNTextInput
        value={String(value)}
        placeholder={block.placeholder}
        placeholderTextColor={tokens.mutedForeground}
        maxLength={200}
        accessibilityLabel={block.label ?? block.id}
        onChangeText={(next) => set(next)}
        style={{ ...INPUT_STYLE, backgroundColor: fieldBg(tokens), color: tokens.foreground }}
      />
    </Field>
  )
}

// ── buttons ────────────────────────────────────────────────────────────────

/**
 * Buttons of the block — the only way OUT of the fence.
 *
 * `send` sends `text` as a user message (this is how the answer
 * asks "want me to do it?"), `copy` copies and `set` writes a value into the
 * inputs. The 1.5 s check confirms the touch; without it the button seems to have
 * done nothing until the agent answer arrives.
 */
export function Buttons({ items }: Of<'buttons'>) {
  const { scope, setValue, send } = useUi()
  const tx = useText()
  const tokens = useTokens()
  const [done, setDone] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const flash = (index: number) => {
    setDone(index)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setDone(null), 1500)
  }

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map((item, i) => {
        const label = tx(item.label)
        const text = tx(item.text ?? item.label)
        const selected = item.action === 'set' && item.id !== undefined && scope[item.id] === item.value
        const primary = item.variant === 'primary' || selected
        const Icon = done === i ? Check : item.action === 'copy' ? Copy : item.action === 'send' ? Send : null
        return (
          <Pressable
            key={i}
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => {
              if (item.action === 'set') {
                if (item.id !== undefined && item.value !== undefined) setValue(item.id, item.value)
                else flash(i)
              } else if (item.action === 'copy') {
                void Clipboard.setStringAsync(text).then(() => flash(i))
              } else if (send(text)) {
                flash(i)
              }
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              borderRadius: 999,
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderWidth: 1,
              borderColor: primary ? tokens.primary : tokens.border,
              backgroundColor: primary ? tokens.primary : 'transparent',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            {Icon ? <Icon size={13} color={primary ? tokens.primaryForeground : tokens.foreground} /> : null}
            <Text
              style={{
                fontSize: 13,
                fontWeight: '500',
                color: primary ? tokens.primaryForeground : tokens.foreground,
              }}
            >
              {label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
