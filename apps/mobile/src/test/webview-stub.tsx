/**
 * `react-native-webview` for jsdom.
 *
 * The real package is Flow code with a native platform module: esbuild does not
 * parse it (`Unexpected token 'typeof'`) and Node has no WebView anyway.
 * Here it becomes an inert `View`, without native props, enough for the
 * markdown tests to mount — the mermaid block became part of that
 * tree, and what is tested in it is the degradation to code, which happens BEFORE
 * the WebView exists.
 *
 * Only the runtime is replaced: the types still come from the real package, so the
 * `type WebViewProps` of whoever consumes it still holds in `tsc`.
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
