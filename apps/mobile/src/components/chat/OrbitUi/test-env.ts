/**
 * Environment for the mobile app component tests.
 *
 * The native modules (expo-*, icons, svg) do not exist in Node and some of them
 * arrive here with Flow syntax, which esbuild does not read. Swapping them for stubs is
 * what allows rendering the REAL component in jsdom — what is tested is the
 * component, not the native bridge.
 *
 * Loaded by `setupFiles` (see vitest.config.ts).
 */
import { vi } from 'vitest'

vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}))

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }))

vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'pt', languageTag: 'pt-BR' }],
}))

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

/**
 * Icons: every name used by the chat components becomes an empty component.
 * The list is explicit on purpose — a Proxy returning a stub for any
 * name also answers to the `then` the loader queries, and the test ends up
 * waiting for a promise that never resolves.
 */
vi.mock('lucide-react-native', () => {
  const names = [
    'AlertCircle',
    'ArrowDownRight',
    'ArrowUpRight',
    'Bot',
    'Brain',
    'Check',
    'ChevronDown',
    'ChevronRight',
    'Circle',
    'CircleAlert',
    'CircleCheck',
    'Copy',
    'Film',
    'Frame',
    'Globe',
    'Info',
    'Link',
    'Maximize2',
    'Monitor',
    'Minus',
    'Pause',
    'Play',
    'Presentation',
    'RotateCw',
    'Search',
    'Send',
    'Sparkles',
    'Terminal',
    'TriangleAlert',
    'X',
  ]
  const icons: Record<string, unknown> = { __esModule: true }
  for (const name of names) icons[name] = () => null
  return icons
})

/** SVG: the drawing is not what is verified; the block is. */
vi.mock('react-native-svg', () => {
  const Shape = () => null
  return { __esModule: true, default: Shape, Circle: Shape, Path: Shape, Polyline: Shape, Text: Shape }
})

/**
 * Global of the RN runtime. `expo` reads `__DEV__` in the interop runtime, which
 * comes in through the module dependency like `expo-image` — without this the module
 * blows up on import, before any test runs.
 */
const runtimeGlobals = globalThis as typeof globalThis & { __DEV__?: boolean }
runtimeGlobals.__DEV__ = true

/** Poster image: loading is not what is verified. */
vi.mock('expo-image', () => ({ Image: () => null }))

/** Safe area insets: in jsdom there is no provider, and the native hook would throw. */
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
  SafeAreaView: ({ children }: { children: unknown }) => children,
}))

/**
 * Asset and file system: the loader of the mermaid bundle is the only
 * consumer the tests reach today. Without a file it returns null, and the
 * diagram falls back to the source code — which is the expected behavior off
 * the device. Without these stubs the import pulls the native expo runtime and blows up.
 */
vi.mock('expo-asset', () => ({
  Asset: {
    fromModule: () => ({ localUri: null, downloadAsync: async () => {} }),
  },
}))

vi.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: async () => '',
}))

/**
 * Gesture and animation: the components are real, the native layers are not.
 * The slider uses RNGH/Reanimated on the device; in jsdom only the rendered
 * structure matters, so the gesture is a chainable no-op and the shared values
 * keep their initial value.
 */
vi.mock('react-native-gesture-handler', () => {
  const chain = () => {
    const gesture: Record<string, unknown> = {}
    for (const method of [
      'maxPointers',
      'activeOffsetX',
      'failOffsetY',
      'onStart',
      'onUpdate',
      'onEnd',
      'onFinalize',
      'maxDistance',
      'minDistance',
      'runOnJS',
    ]) {
      gesture[method] = () => gesture
    }
    return gesture
  }
  return {
    Gesture: { Pan: chain, Tap: chain, Race: () => ({}) },
    GestureDetector: ({ children }: { children: unknown }) => children,
  }
})

vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native')
  return {
    __esModule: true,
    default: { View },
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    useSharedValue: (initial: unknown) => ({
      value: initial,
      get: () => initial,
      set: () => {},
    }),
    useAnimatedStyle: () => ({}),
  }
})
