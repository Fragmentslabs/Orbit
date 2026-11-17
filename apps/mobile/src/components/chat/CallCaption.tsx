import { useEffect, useState } from 'react'
import { Animated, Easing, View } from 'react-native'

const LINES = 3
const LINE_HEIGHT = 20
const FADE_STEPS = 4

/**
 * The call's words as film credits: a window that grows with the text up to a few lines and,
 * once it no longer fits, the older lines slide up and out while the newest stay in view — the
 * desktop's caption behaviour. The top edge fades into the background (stepped strips: the app
 * has no gradient dependency).
 */
export function CallCaption({
  text,
  color,
  background,
}: {
  text: string
  color: string
  background: string
}) {
  const maxHeight = LINES * LINE_HEIGHT
  const [contentHeight, setContentHeight] = useState(0)
  const [offset] = useState(() => new Animated.Value(0))
  const [windowHeight] = useState(() => new Animated.Value(0))

  // Where the content must sit so its bottom lines are the visible ones.
  // The window is as tall as the text up to `LINES` lines, so there is no empty space above a short
  // caption; past that the content slides up (negative offset) and the newest lines stay in view.
  const shown = Math.min(contentHeight, maxHeight)
  const target = Math.min(0, maxHeight - contentHeight)
  useEffect(() => {
    const easing = Easing.out(Easing.cubic)
    Animated.timing(offset, { toValue: target, duration: 260, easing, useNativeDriver: true }).start()
    // Layout property: the JS driver (it cannot run natively).
    Animated.timing(windowHeight, { toValue: shown, duration: 260, easing, useNativeDriver: false }).start()
  }, [target, shown, offset, windowHeight])

  return (
    <Animated.View style={{ height: windowHeight, overflow: 'hidden', marginBottom: 6 }}>
      <Animated.View
        style={{ position: 'absolute', left: 0, right: 0, top: 0, transform: [{ translateY: offset }] }}
        onLayout={(e) => {
          const measured = e.nativeEvent.layout.height
          // The first line appears in place instead of growing in from nothing.
          if (contentHeight === 0) windowHeight.setValue(Math.min(measured, maxHeight))
          setContentHeight(measured)
        }}
      >
        <Animated.Text style={{ color, fontSize: 15, lineHeight: LINE_HEIGHT }}>{text}</Animated.Text>
      </Animated.View>
      {/* The fade only exists once lines are leaving through the top. */}
      {contentHeight > maxHeight && Array.from({ length: FADE_STEPS }, (_, i) => (
        <View
          key={i}
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: i * (LINE_HEIGHT / FADE_STEPS) * 1.4,
            left: 0,
            right: 0,
            height: (LINE_HEIGHT / FADE_STEPS) * 1.4,
            backgroundColor: background,
            opacity: 0.85 - (i * 0.85) / FADE_STEPS,
          }}
        />
      ))}
    </Animated.View>
  )
}
