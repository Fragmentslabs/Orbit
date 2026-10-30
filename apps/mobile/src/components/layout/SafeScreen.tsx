import type { ReactNode } from 'react'
import { View } from 'react-native'
import type { StyleProp, ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

type Edge = 'top' | 'right' | 'bottom' | 'left'
type Edges = readonly Edge[]

interface SafeScreenProps {
  children: ReactNode
  edges?: Edges
  style?: StyleProp<ViewStyle>
  backgroundColor?: string
}

/**
 * Screen wrapper with a context-based safe area (`useSafeAreaInsets`).
 *
 * Replaces the native `SafeAreaView` of react-native-safe-area-context v5, which
 * applies the insets through an asynchronous native layout pass: during the
 * native-stack transitions the content of the new screen mounted glued to the top
 * (under the notch/status bar) and only "jumped" to the right position after the
 * native view re-measured. Here the insets come from the SafeAreaProvider (synchronous) and the
 * padding is applied straight on the View.
 */
export function SafeScreen({ children, edges = ['top'], style, backgroundColor }: SafeScreenProps) {
  const insets = useSafeAreaInsets()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const padding = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingRight: edges.includes('right') ? insets.right : 0,
    paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
    paddingLeft: edges.includes('left') ? insets.left : 0,
  }

  return (
    <View style={[{ flex: 1, backgroundColor: backgroundColor ?? tokens.background }, padding, style]}>
      {children}
    </View>
  )
}
