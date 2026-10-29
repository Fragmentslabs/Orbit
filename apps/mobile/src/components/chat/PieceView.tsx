/**
 * Host de WebView para uma "peça" HTML vinda do desktop.
 *
 * O desktop reescreve a URL antes de mandá-la para o celular (`companion-media`):
 * o que chega aqui já é uma URL http absoluta, com token no caminho. Este
 * componente NÃO monta URL nenhuma — ele só renderiza o que recebeu, seja de
 * uma URL, seja do HTML que o próprio celular escreveu (o diagrama mermaid).
 * Fonte vazia (part antiga em cache, arquivo que não pôde ser servido) degrada
 * para um card discreto em vez de um buraco na conversa.
 *
 * A API é a mesma para todos os tipos de peça porque todos compartilham o mesmo
 * problema: um HTML que precisa de um host, um poster enquanto carrega, um erro
 * que não pode derrubar a bolha e uma tela cheia para o que não cabe na largura
 * do celular. Artefato e documento usam agora; motion, design e slides usam
 * depois, sem inventar um segundo host.
 */
import { useCallback, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { WebView, type WebViewProps } from 'react-native-webview'
import { Image } from 'expo-image'
import { AlertCircle, Maximize2, RotateCw, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { UnavailablePart } from './parts/UnavailablePart'

type WebViewErrorEvent = Parameters<NonNullable<WebViewProps['onError']>>[0]
type WebViewHttpErrorEvent = Parameters<NonNullable<WebViewProps['onHttpError']>>[0]

export interface PieceViewProps {
  /** URL http absoluta do HTML (já reescrita pelo desktop). Vazia = sem prévia. */
  src?: string
  /**
   * HTML montado no próprio celular, sem arquivo no desktop — o diagrama
   * mermaid não tem URL para servir. Tem prioridade sobre `src` quando os dois
   * vêm; vazio nos dois = card de "prévia indisponível".
   */
  html?: string
  /** Título na barra do card e no cabeçalho da tela cheia. */
  title?: string
  /** Poster mostrado enquanto o HTML carrega — normalmente o `thumb` da part. */
  poster?: string
  /**
   * Revisão do conteúdo (`revision` da part). O desktop reescreve o mesmo
   * arquivo no mesmo caminho, então sem isto o WebView continuaria mostrando a
   * versão anterior depois de um `update_artifact`.
   */
  revision?: number
  /** Altura do host inline, em px. Padrão 320. */
  height?: number
  /** Mostra o botão de expandir para tela cheia. Padrão true. */
  expandable?: boolean
  /** Conteúdo extra logo abaixo do host (os botões do documento, por exemplo). */
  footer?: ReactNode
  /** Rótulo do estado vazio (URL ausente). */
  emptyLabel?: string
  /** Rótulo do estado de carregamento, para leitor de tela. */
  loadingLabel?: string
  /** Rótulo do estado de erro. */
  errorLabel?: string
  /** Avisa quem chamou quando a página não carrega (rede, 404, token expirado). */
  onError?: (message: string) => void
  /**
   * Mensagens do documento (`window.ReactNativeWebView.postMessage`). É por
   * aqui que uma peça que se desenha sozinha — o diagrama mermaid — avisa a
   * altura de que precisa.
   */
  onMessage?: (data: string) => void
}

type LoadState = 'loading' | 'ready' | 'error'

export function PieceView({
  src,
  html,
  title,
  poster,
  revision,
  height = 320,
  expandable = true,
  footer,
  emptyLabel,
  loadingLabel,
  errorLabel,
  onError,
  onMessage,
}: PieceViewProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()

  // Cada parte fala a sua língua ("Prévia do artefato", "Carregando documento").
  // Sem rótulo do chamador, o genérico traduzido — nunca uma string solta.
  const emptyText = emptyLabel ?? t('parts.preview.empty')
  const loadingText = loadingLabel ?? t('parts.preview.loading')
  const errorText = errorLabel ?? t('parts.preview.error')

  const [state, setState] = useState<LoadState>('loading')
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)

  // Nova URL (ou nova revisão do mesmo arquivo) recomeça do loading: o latch de
  // erro/ready não pode sobreviver à troca de fonte, senão a part reemitida com
  // token fresco mostraria o erro da anterior. Ajuste durante a renderização
  // (padrão do React para estado derivado de prop) em vez de efeito: o efeito
  // deixaria um render intermediário mostrando o estado da fonte anterior.
  // Com `html` a identidade da fonte é o próprio documento — o diagrama é
  // montado aqui, não tem URL. Trocar de tema ou de diagrama remonta o WebView.
  const sourceKey = src ? `${src}#${revision ?? 0}` : `html:${html ?? ''}`
  const [seenSource, setSeenSource] = useState(sourceKey)
  if (seenSource !== sourceKey) {
    setSeenSource(sourceKey)
    setState('loading')
    setErrorDetail(null)
  }

  const fail = useCallback(
    (detail: string | null) => {
      setState('error')
      setErrorDetail(detail)
      onError?.(detail ?? 'load failed')
    },
    [onError],
  )

  const retry = useCallback(() => {
    setState('loading')
    setErrorDetail(null)
    setAttempt((n) => n + 1)
  }, [])

  // `attempt` no key força um WebView novo a cada tentativa — `reload()` não
  // resolve quando o problema foi a resposta HTTP em si.
  const webKey = `${sourceKey}#${attempt}`

  const handleError = useCallback(
    (event: WebViewErrorEvent) => fail(event.nativeEvent.description || null),
    [fail],
  )

  const handleHttpError = useCallback(
    (event: WebViewHttpErrorEvent) => fail(`HTTP ${event.nativeEvent.statusCode}`),
    [fail],
  )

  const renderWeb = (expanded: boolean) => (
    <WebView
      key={webKey}
      source={html ? { html } : { uri: src as string }}
      style={styles.web}
      // A página da peça puxa os próprios assets por caminho relativo (CSS,
      // fonte, clipe) e pode apontar para fora — nada de whitelist restritiva.
      originWhitelist={['*']}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      // A peça é um documento, não um navegador: `window.open` abriria uma
      // janela que o RN não tem onde mostrar.
      setSupportMultipleWindows={false}
      onLoadStart={() => setState((prev) => (prev === 'error' ? prev : 'loading'))}
      onLoadEnd={() => setState((prev) => (prev === 'error' ? prev : 'ready'))}
      onError={handleError}
      onHttpError={handleHttpError}
      onMessage={(event) => onMessage?.(event.nativeEvent.data)}
      accessibilityLabel={title}
      testID={expanded ? 'piece-view-fullscreen' : 'piece-view'}
    />
  )

  // Part antiga em cache (ou arquivo que o desktop não conseguiu servir): o
  // card continua lá, dizendo o que era, em vez de sumir.
  if (!src && !html) {
    return <UnavailablePart title={title} label={emptyText} testID="piece-empty" />
  }

  return (
    <>
      <View
        className="mt-2 w-full overflow-hidden rounded-lg"
        style={{ borderWidth: 1, borderColor: tokens.border }}
      >
        <View
          className="flex-row items-center gap-2 px-3 py-2"
          style={{ backgroundColor: tokens.muted }}
        >
          <Text
            numberOfLines={1}
            className="flex-1 text-xs font-medium"
            style={{ color: tokens.foreground }}
          >
            {title ?? ''}
          </Text>
          {expandable ? (
            <Pressable
              onPress={() => setFullscreen(true)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('parts.preview.expand')}
            >
              <Maximize2 size={14} color={tokens.mutedForeground} />
            </Pressable>
          ) : null}
        </View>

        <View style={{ height }}>
          {state !== 'error' && renderWeb(false)}

          {state === 'loading' ? (
            <View style={styles.overlay} pointerEvents="none">
              {poster ? (
                <Image
                  source={poster}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  // Poster é enfeite: se o thumb falhar, o spinner já resolve.
                  accessibilityIgnoresInvertColors
                />
              ) : null}
              <View style={styles.overlayScrim}>
                <ActivityIndicator color={tokens.primary} accessibilityLabel={loadingText} />
              </View>
            </View>
          ) : null}

          {state === 'error' ? (
            <View style={styles.overlay}>
              <AlertCircle size={18} color={tokens.mutedForeground} />
              <Text className="text-xs" style={{ color: tokens.mutedForeground, textAlign: 'center' }}>
                {errorText}
              </Text>
              <Pressable
                onPress={retry}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('parts.preview.retry')}
                className="flex-row items-center gap-1 rounded-md px-2 py-1"
                style={{ backgroundColor: tokens.muted }}
              >
                <RotateCw size={12} color={tokens.foreground} />
                <Text className="text-xs" style={{ color: tokens.foreground }}>
                  Tentar de novo
                </Text>
              </Pressable>
              {errorDetail ? (
                <Text
                  numberOfLines={2}
                  className="text-[10px]"
                  style={{ color: tokens.mutedForeground, opacity: 0.7, textAlign: 'center' }}
                >
                  {errorDetail}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>

        {footer}
      </View>

      <Modal
        visible={fullscreen}
        animationType="slide"
        onRequestClose={() => setFullscreen(false)}
        statusBarTranslucent
      >
        <View style={[styles.fullscreen, { backgroundColor: tokens.background, paddingTop: insets.top }]}>
          <View className="flex-row items-center gap-2 px-3 py-2">
            <Text
              numberOfLines={1}
              className="flex-1 text-sm font-medium"
              style={{ color: tokens.foreground }}
            >
              {title ?? ''}
            </Text>
            <Pressable
              onPress={() => setFullscreen(false)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Fechar"
            >
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>
          <View style={{ flex: 1, paddingBottom: insets.bottom }}>{renderWeb(true)}</View>
        </View>
      </Modal>
    </>
  )
}

const fill = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: 'transparent' },
  overlay: {
    ...fill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  overlayScrim: {
    ...fill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  fullscreen: { flex: 1 },
})
