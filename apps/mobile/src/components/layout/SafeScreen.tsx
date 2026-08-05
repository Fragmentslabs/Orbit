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
 * Wrapper de tela com safe area baseado em contexto (`useSafeAreaInsets`).
 *
 * Substitui o `SafeAreaView` nativo do react-native-safe-area-context v5, que
 * aplica os insets por meio de um layout pass nativo assíncrono: durante as
 * transições do native-stack o conteúdo da tela nova montava grudado no topo
 * (sob a notch/status bar) e só "pulava" para a posição correta depois que o
 * view nativo re-mede. Aqui os insets vêm do SafeAreaProvider (síncrono) e o
 * padding é aplicado direto no View.
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
