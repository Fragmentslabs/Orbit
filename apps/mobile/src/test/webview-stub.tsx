/**
 * `react-native-webview` para o jsdom.
 *
 * O pacote real é código Flow com módulo de plataforma nativa: o esbuild não
 * parseia (`Unexpected token 'typeof'`) e o Node não tem WebView de qualquer
 * forma. Aqui ele vira uma `View` inerte, sem props nativas, o suficiente para
 * os testes de markdown montarem — o bloco mermaid passou a fazer parte dessa
 * árvore, e o que se testa nele é a degradação para código, que acontece ANTES
 * de o WebView existir.
 *
 * Só o runtime é substituído: os tipos continuam vindo do pacote real, então o
 * `type WebViewProps` de quem consome segue valendo no `tsc`.
 */
import { View, type StyleProp, type ViewStyle } from 'react-native'

interface WebViewStubProps {
  testID?: string
  style?: StyleProp<ViewStyle>
  accessibilityLabel?: string
}

export function WebView({ testID, style, accessibilityLabel }: WebViewStubProps) {
  return <View testID={testID ?? 'webview-stub'} style={style} accessibilityLabel={accessibilityLabel} />
}
