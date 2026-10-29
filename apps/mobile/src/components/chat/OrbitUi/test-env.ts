/**
 * Ambiente dos testes de componente do app mobile.
 *
 * Os módulos nativos (expo-*, ícones, svg) não existem no Node e alguns deles
 * chegam até aqui com sintaxe Flow, que o esbuild não lê. Trocá-los por stubs é
 * o que permite renderizar o componente REAL no jsdom — o que se testa é o
 * componente, não a ponte nativa.
 *
 * Carregado por `setupFiles` (ver vitest.config.ts).
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
 * Ícones: cada nome usado pelos componentes de chat vira um componente vazio.
 * A lista é explícita de propósito — um Proxy devolvendo stub para qualquer
 * nome também responde ao `then` que o loader consulta, e o teste fica
 * esperando uma promessa que nunca resolve.
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
    'Globe',
    'Info',
    'Link',
    'Maximize2',
    'Monitor',
    'Minus',
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

/** SVG: o desenho não é o que se verifica; o bloco é. */
vi.mock('react-native-svg', () => {
  const Shape = () => null
  return { __esModule: true, default: Shape, Circle: Shape, Path: Shape, Polyline: Shape, Text: Shape }
})

/**
 * Global do runtime do RN. O `expo` lê `__DEV__` no runtime de inverno, que
 * entra pela dependência de módulos como `expo-image` — sem isto o módulo
 * estoura no import, antes de qualquer teste rodar.
 */
const runtimeGlobals = globalThis as typeof globalThis & { __DEV__?: boolean }
runtimeGlobals.__DEV__ = true

/** Imagem de poster: o carregamento não é o que se verifica. */
vi.mock('expo-image', () => ({ Image: () => null }))

/** Insets de área segura: no jsdom não há provider, e o hook nativo lançaria. */
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
  SafeAreaView: ({ children }: { children: unknown }) => children,
}))

/**
 * Asset e sistema de arquivos: o carregador do bundle do mermaid é o único
 * consumidor que os testes alcançam hoje. Sem arquivo ele devolve null, e o
 * diagrama cai no código-fonte — que é o comportamento esperado fora do
 * aparelho. Sem estes stubs o import puxa o runtime nativo do expo e estoura.
 */
vi.mock('expo-asset', () => ({
  Asset: {
    fromModule: () => ({ localUri: null, downloadAsync: async () => {} }),
  },
}))

vi.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: async () => '',
}))
