/**
 * The pieces the three viewers share, so motion, design and slides read as one family: the
 * same stage (the piece centered on a neutral ground, scaled to fit, never cropped) and the same
 * control bar underneath (one height, one border, one round button). What differs between the
 * types is only what goes in the bar — a ruler, arrows, a counter.
 */
import type { LucideIcon } from 'lucide-react-native'
import { useCallback, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/** Control bar, without the bottom inset. */
export const BAR_HEIGHT = 56

export interface Box {
  width: number
  height: number
}

/** The largest size with the content's proportions that fits the box (never above 1:1 of the box). */
export function fitSize(box: Box | null, content: Box | null): (Box & { scale: number }) | null {
  if (!box || !content || box.width <= 0 || box.height <= 0 || content.width <= 0 || content.height <= 0) {
    return null
  }
  const scale = Math.min(box.width / content.width, box.height / content.height)
  if (!Number.isFinite(scale) || scale <= 0) return null
  return { width: Math.floor(content.width * scale), height: Math.floor(content.height * scale), scale }
}

/** Measures the stage: the viewer needs its box to know how much to scale the piece. */
export function useStageBox(): { box: Box | null; onLayout: (event: LayoutChangeEvent) => void } {
  const [box, setBox] = useState<Box | null>(null)
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    setBox((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }))
  }, [])
  return { box, onLayout }
}

/**
 * Where the piece lives. With a `size` the child is exactly that big and centered (letterboxed
 * on the neutral ground); without one — the page has not said what size it is yet — it fills.
 */
export function Stage({
  onLayout,
  size,
  children,
}: {
  onLayout?: (event: LayoutChangeEvent) => void
  size: Box | null
  children: ReactNode
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <View
      testID="viewer-stage"
      onLayout={onLayout}
      // The dead area around a letterboxed piece is the app's own background, not a gray band.
      style={[styles.stage, { backgroundColor: tokens.background }]}
    >
      <View style={size ? { width: size.width, height: size.height } : styles.fill}>{children}</View>
    </View>
  )
}

/**
 * The loading face of a viewer: the app background with the spinner, laid over whatever is
 * still being prepared (the WebView, the probe of the piece). It never lets the raw white of an
 * unpainted WebView show through.
 */
export function StageLoading({ label }: { label: string }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <View
      testID="stage-loading"
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.loading, { backgroundColor: tokens.background }]}
    >
      <ActivityIndicator color={tokens.primary} accessibilityLabel={label} />
    </View>
  )
}

/** The bar under the stage. `children` are laid out in a row, 8 apart. */
export function ViewerBar({ children }: { children: ReactNode }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  return (
    <View
      style={[
        styles.bar,
        {
          height: BAR_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
          borderTopColor: tokens.border,
          backgroundColor: tokens.background,
        },
      ]}
    >
      {children}
    </View>
  )
}

/** The round 36px button every bar uses. */
export function BarButton({
  icon: Icon,
  label,
  onPress,
  disabled,
  active,
  filled,
  testID,
}: {
  icon: LucideIcon
  label: string
  onPress: () => void
  disabled?: boolean
  /** A toggle that is on (loop). */
  active?: boolean
  /** The main action of the bar (play) gets the filled look. */
  filled?: boolean
  testID?: string
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled), ...(active !== undefined ? { selected: active } : {}) }}
      accessibilityLabel={label}
      style={[
        styles.button,
        {
          backgroundColor: filled ? tokens.primary : tokens.muted,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Icon
        size={18}
        color={filled ? tokens.primaryForeground : active === false ? tokens.mutedForeground : tokens.foreground}
      />
    </Pressable>
  )
}

/**
 * Scales the document of the piece to fit the stage.
 *
 * The composition is a fixed-size page (1920×1080 in the common case), so on a
 * phone the WebView would show only its corner. `zoom` on `<html>` reflows the
 * document to the right visual size — unlike `transform`, which would scale it
 * without shrinking the scrollable area. The `<meta viewport>` exists so the WebView does not
 * use the virtual 980px viewport of the Android "desktop" mode.
 */
export function fitScript(scale: number): string {
  return `(function () {
  try {
    var head = document.head || document.documentElement;
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      head.appendChild(meta);
    }
    meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
    document.documentElement.style.zoom = '${scale.toFixed(4)}';
  } catch (err) {}
})();
true;`
}

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  fill: { alignSelf: 'stretch', flex: 1, width: '100%' },
  loading: { alignItems: 'center', justifyContent: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  button: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
})
