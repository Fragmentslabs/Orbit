/**
 * Motion no celular: o player.
 *
 * A peça de motion NÃO tem relógio próprio. Ela declara o formato num
 * `<meta name="orbit-motion" content="width=…,fps=30,duration=6">` (ou em
 * `window.orbitMotion`) e só se move quando alguém chama
 * `window.orbitMotion.seek(quadro)` — sempre um INTEIRO de quadro; o runtime do
 * desktop converte para segundos (`t = quadro / fps`). Por isso o scrubber aqui
 * não é enfeite: sem um seek por quadro, a peça fica parada no primeiro.
 *
 * O caminho de fala com a página é o `onReady` do `PieceView`, que entrega o
 * `injectJavaScript` do WebView depois do load. Daqui saem três injeções:
 *
 *  1. a sonda que pergunta o formato (a resposta volta por postMessage);
 *  2. o `seek(quadro)` — o movimento em si;
 *  3. o enquadramento (`zoom`) da peça no palco: a composição é um documento de
 *     1920×1080 (o guia de motion proíbe layout responsivo), e sem escala num
 *     telefone se veria o canto superior esquerdo dela.
 *
 * Nada de URL montada aqui: `piece.url` já vem assinada pelo desktop e os
 * assets relativos da peça carregam junto por causa do token no caminho.
 */
import { Pause, Play, Repeat } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

import { PieceView } from '../../PieceView'

import type { PieceViewerProps } from './index'

/** O fps padrão do contrato (`MOTION_FPS` do runtime do desktop). */
const DEFAULT_FPS = 30
/** Marca das mensagens desta tela — a peça pode postar outras, e não são nossas. */
const MESSAGE_SOURCE = 'orbit-motion-player'
/** Moldura do host: `mt-2` + a barra de título do `PieceView` + as bordas. */
const HOST_CHROME = 42
/** Barra de controles, sem o inset de baixo. */
const CONTROLS_HEIGHT = 52
/** Abaixo disso a peça deixa de ser vista; melhor um palco baixo que nenhum. */
const MIN_STAGE = 120

export interface MotionSpec {
  /** Quadros por segundo declarados pela peça (ou o padrão do contrato). */
  fps: number
  /** Comprimento em QUADROS — a unidade do `seek`. */
  frames: number
  /** Tamanho do documento da composição, para enquadrá-la no palco. */
  width: number
  height: number
  /** A página expõe `orbitMotion.seek`: sem isso nada anda. */
  seekable: boolean
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * O que a página respondeu, na ordem de precedência do runtime do desktop:
 * `durationInFrames` é canônico e vence tudo; senão vale a duração declarada em
 * segundos, depois a timeline do GSAP e por último a `<meta>`. O fps resolve
 * antes de qualquer conta, porque segundos viram quadros com ele.
 *
 * `fallbackSeconds` é o `piece.count` (a duração que o desktop já conhece):
 * só entra quando a página não declara comprimento nenhum — peça antiga, ou
 * runtime que não chegou a rodar. Sem nada disso, `null`: melhor um controle
 * desligado do que uma duração inventada.
 */
export function resolveSpec(
  raw: Record<string, unknown>,
  fallbackSeconds?: number,
): MotionSpec | null {
  const fps = positive(raw.fps) || positive(raw.metaFps) || DEFAULT_FPS
  const declaredFrames = positive(raw.durationInFrames)
  let frames = declaredFrames ? Math.max(1, Math.round(declaredFrames)) : 0
  if (!frames) {
    const seconds =
      positive(raw.duration) || positive(raw.timeline) || positive(raw.metaDuration) || positive(fallbackSeconds)
    if (seconds > 0) frames = Math.max(1, Math.round(seconds * fps))
  }
  if (!frames) return null
  return {
    fps,
    frames,
    width: positive(raw.width) || positive(raw.metaWidth) || 1920,
    height: positive(raw.height) || positive(raw.metaHeight) || 1080,
    seekable: raw.seek === true,
  }
}

/**
 * `0:01` — minutos só quando existem, segundos sempre com dois dígitos.
 *
 * Arredonda em vez de truncar porque o número é lido junto com a régua: truncado,
 * o último quadro de uma peça de 3 s (2,97 s) apareceria como `0:02 / 0:03` com
 * a régua no fim.
 */
export function formatTime(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}

/** O quadro sob o dedo: o `locationX` é relativo à trilha, então razão = x/width. */
export function frameAtX(x: number, width: number, frames: number): number {
  if (!(width > 0) || !(frames > 0)) return 0
  const ratio = Math.min(1, Math.max(0, x / width))
  return Math.round(ratio * (frames - 1))
}

/**
 * A sonda. Lê o que a página tem sem tocar em nada: `orbitMotion` (declarado
 * pela composição, ou resolvido pelo runtime quando ele foi injetado), a
 * `<meta>` do próprio documento, a timeline do GSAP e se existe um `seek` para
 * chamar. Volta por `postMessage` — não há valor de retorno em
 * `injectJavaScript`.
 */
const PROBE_JS = `(function () {
  var reply = function (payload) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    } catch (err) {}
  };
  try {
    var api = window.orbitMotion || null;
    var meta = document.querySelector('meta[name="orbit-motion"]');
    var metaFps = 0, metaDuration = 0, metaWidth = 0, metaHeight = 0;
    if (meta) {
      var pairs = String(meta.getAttribute('content') || '').split(/[,;]/);
      for (var i = 0; i < pairs.length; i++) {
        var at = pairs[i].indexOf('=');
        if (at < 0) continue;
        var key = pairs[i].slice(0, at).trim();
        var num = Number(pairs[i].slice(at + 1).trim());
        if (!isFinite(num) || num <= 0) continue;
        if (key === 'fps') metaFps = num;
        else if (key === 'duration') metaDuration = num;
        else if (key === 'width') metaWidth = num;
        else if (key === 'height') metaHeight = num;
      }
    }
    var timeline = 0;
    try {
      if (window.orbitTimeline && typeof window.orbitTimeline.duration === 'function') {
        var seconds = window.orbitTimeline.duration();
        if (typeof seconds === 'number' && isFinite(seconds) && seconds > 0) timeline = seconds;
      }
    } catch (err) {}
    reply({
      source: '${MESSAGE_SOURCE}',
      type: 'spec',
      fps: api && typeof api.fps === 'number' ? api.fps : 0,
      duration: api && typeof api.duration === 'number' ? api.duration : 0,
      durationInFrames: api && typeof api.durationInFrames === 'number' ? api.durationInFrames : 0,
      width: api && typeof api.width === 'number' ? api.width : 0,
      height: api && typeof api.height === 'number' ? api.height : 0,
      metaFps: metaFps,
      metaDuration: metaDuration,
      metaWidth: metaWidth,
      metaHeight: metaHeight,
      timeline: timeline,
      seek: !!(api && typeof api.seek === 'function')
    });
  } catch (err) {
    reply({ source: '${MESSAGE_SOURCE}', type: 'error', message: String((err && err.message) || err) });
  }
})();
true;`

/**
 * O movimento: um quadro inteiro. O `try` existe porque o `seek` é código da
 * peça — se ele estourar, a tela precisa saber (e parar), não morrer calada.
 */
export function seekScript(frame: number): string {
  return `(function () {
  try {
    var api = window.orbitMotion;
    if (api && typeof api.seek === 'function') api.seek(${Math.max(0, Math.round(frame))});
  } catch (err) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        source: '${MESSAGE_SOURCE}', type: 'error', message: String((err && err.message) || err)
      }));
    } catch (ignored) {}
  }
})();
true;`
}

/**
 * Escala o documento da peça para caber no palco.
 *
 * A composição é uma página de tamanho fixo (1920×1080 no caso comum), então num
 * telefone o WebView mostraria só o canto dela. `zoom` no `<html>` reflui o
 * documento no tamanho visual certo — diferente de `transform`, que escalaria
 * sem encolher a área rolável. A `<meta viewport>` existe para o WebView não
 * usar a viewport virtual de 980px do modo "desktop" do Android.
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

interface PageReply {
  source?: unknown
  type?: unknown
}

export function MotionViewer({ piece }: PieceViewerProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const dimensions = useWindowDimensions()

  // Espaço que a casca deu ao viewer (flex:1, já sem o cabeçalho da tela cheia).
  // Medido em vez de deduzido: o cabeçalho não é desta tela e mudaria a conta.
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  const [spec, setSpec] = useState<MotionSpec | null>(null)
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  // A página recusou o seek (ou o runtime dela estourou): o controle para de
  // fingir que funciona.
  const [broken, setBroken] = useState(false)
  // Quantas cargas a página teve. Cada uma pede sonda nova e um seek novo —
  // `frame` sozinho não muda quando o WebView recarrega por baixo.
  const [loads, setLoads] = useState(0)
  const [trackWidth, setTrackWidth] = useState(0)

  const injectRef = useRef<((js: string) => void) | null>(null)
  const frameRef = useRef(0)

  const stageWidth = Math.max(0, box?.width ?? dimensions.width)
  const stageHeight = Math.max(
    MIN_STAGE,
    (box?.height ?? dimensions.height - 120) - CONTROLS_HEIGHT - HOST_CHROME - insets.bottom,
  )

  const duration = spec ? spec.frames / spec.fps : piece.count ?? 0
  const position = spec ? frame / spec.fps : 0
  const canSeek = Boolean(spec?.seekable) && !broken
  const ratio = spec && spec.frames > 1 ? Math.min(1, Math.max(0, frame / (spec.frames - 1))) : 0
  const timeLabel = `${formatTime(position)} / ${duration > 0 ? formatTime(duration) : '–:–'}`

  // Espelho do quadro para o relógio do play: o efeito lê o valor de partida
  // quando começa, e um estado atrasado faria o primeiro tique pular.
  useEffect(() => {
    frameRef.current = frame
  }, [frame])

  // O único movimento da peça sai daqui: um `seek` por quadro exibido.
  useEffect(() => {
    if (loads === 0) return
    injectRef.current?.(seekScript(frame))
  }, [loads, frame])

  // Play: relógio da tela, não da página. Cada tique deriva o quadro do tempo
  // decorrido (e não de um contador) para não acumular atraso de timer.
  useEffect(() => {
    if (!playing || !spec) return
    const stepMs = 1000 / spec.fps
    const origin = Date.now()
    const base = frameRef.current
    const timer = setInterval(() => {
      const advanced = base + Math.floor((Date.now() - origin) / stepMs)
      if (advanced < spec.frames) {
        setFrame(advanced)
        return
      }
      if (loop) {
        setFrame(advanced % spec.frames)
        return
      }
      setFrame(spec.frames - 1)
      setPlaying(false)
    }, Math.max(16, Math.round(stepMs)))
    return () => clearInterval(timer)
  }, [playing, spec, loop])

  // Enquadramento: só depois de saber o tamanho do documento (a sonda respondeu)
  // e refeito quando o palco muda — girar o telefone muda a escala.
  useEffect(() => {
    if (!spec || loads === 0 || stageWidth <= 0) return
    const scale = Math.min(stageWidth / spec.width, stageHeight / spec.height)
    if (!(scale > 0) || !Number.isFinite(scale)) return
    injectRef.current?.(fitScript(scale))
  }, [spec, loads, stageWidth, stageHeight])

  const handleReady = useCallback((inject: (js: string) => void) => {
    injectRef.current = inject
    setBroken(false)
    setPlaying(false)
    setFrame(0)
    frameRef.current = 0
    inject(PROBE_JS)
    setLoads((n) => n + 1)
  }, [])

  const handleMessage = useCallback(
    (data: string) => {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        return
      }
      if (!payload || typeof payload !== 'object') return
      const reply = payload as PageReply
      if (reply.source !== MESSAGE_SOURCE) return
      if (reply.type === 'error') {
        setBroken(true)
        setPlaying(false)
        return
      }
      if (reply.type !== 'spec') return
      const next = resolveSpec(reply as Record<string, unknown>, piece.count)
      setSpec(next)
      if (!next?.seekable) setPlaying(false)
    },
    [piece.count],
  )

  const togglePlay = useCallback(() => {
    if (!spec || !spec.seekable || broken) return
    if (playing) {
      setPlaying(false)
      return
    }
    // Parado no fim, tocar recomeça — senão o botão não faria nada.
    if (frameRef.current >= spec.frames - 1) {
      frameRef.current = 0
      setFrame(0)
    }
    setPlaying(true)
  }, [spec, broken, playing])

  // Arrastar a régua pausa: o play é um relógio que parte de um quadro fixo, e
  // continuar tocando de outro ponto exigiria reiniciá-lo no meio do gesto.
  const seekTo = useCallback(
    (next: number) => {
      if (!spec) return
      const clamped = Math.min(spec.frames - 1, Math.max(0, Math.round(next)))
      setPlaying(false)
      frameRef.current = clamped
      setFrame(clamped)
    },
    [spec],
  )

  const onTrackTouch = useCallback(
    (event: GestureResponderEvent) => {
      if (!spec || trackWidth <= 0) return
      seekTo(frameAtX(event.nativeEvent.locationX, trackWidth, spec.frames))
    },
    [spec, trackWidth, seekTo],
  )

  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width)
  }, [])

  // O palco não muda enquanto a peça toca — e tocar re-renderiza este componente
  // a cada quadro. Sem o memo, o host do WebView seria reconstruído 30 vezes por
  // segundo à toa, junto com os `inject`s que ele dispara por `onReady`.
  const stage = useMemo(
    () => (
      <PieceView
        src={piece.url}
        title={piece.title}
        revision={0}
        height={stageHeight}
        expandable={false}
        loadingLabel={t('parts.preview.loading')}
        errorLabel={t('parts.preview.error')}
        onReady={handleReady}
        onMessage={handleMessage}
        onError={() => {
          setBroken(true)
          setPlaying(false)
        }}
      />
    ),
    [piece.url, piece.title, stageHeight, t, handleReady, handleMessage],
  )

  return (
    <View
      className="flex-1"
      onLayout={(event) =>
        setBox({
          width: event.nativeEvent.layout.width,
          height: event.nativeEvent.layout.height,
        })
      }
    >
      {stage}

      <View
        className="flex-row items-center gap-2 px-3"
        style={{
          height: CONTROLS_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: tokens.border,
          backgroundColor: tokens.background,
        }}
      >
        <Pressable
          testID="motion-play"
          onPress={togglePlay}
          disabled={!canSeek}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSeek }}
          accessibilityLabel={t(playing ? 'pieces.motion.pause' : 'pieces.motion.play')}
          className="h-9 w-9 items-center justify-center rounded-full"
          style={{ backgroundColor: tokens.muted, opacity: canSeek ? 1 : 0.4 }}
        >
          {playing ? (
            <Pause size={16} color={tokens.foreground} />
          ) : (
            <Play size={16} color={tokens.foreground} />
          )}
        </Pressable>

        {/* A régua: toque e arrasto viram quadro. `locationX` já vem relativo à
            trilha, então a razão x/largura é o próprio progresso. */}
        <View
          testID="motion-track"
          accessibilityRole="adjustable"
          // O nome da peça é o que a pessoa reconhece; não há chave de locale
          // para "linha do tempo" (ver relatório).
          accessibilityLabel={piece.title?.trim() || t('pieces.kind.motion')}
          // `aria-value*` e não `accessibilityValue`: são a mesma coisa no
          // nativo e, no WebView de teste (react-native-web), só estes chegam ao
          // DOM — é por eles que o leitor de tela anuncia a posição.
          aria-valuemin={0}
          aria-valuemax={spec ? spec.frames - 1 : 0}
          aria-valuenow={frame}
          aria-valuetext={timeLabel}
          style={styles.trackTouch}
          onLayout={onTrackLayout}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={onTrackTouch}
          onResponderMove={onTrackTouch}
        >
          <View style={[styles.rail, { backgroundColor: tokens.secondary }]}>
            <View
              style={{ width: `${ratio * 100}%`, height: '100%', backgroundColor: tokens.primary }}
            />
          </View>
          <View
            style={[
              styles.thumb,
              {
                backgroundColor: tokens.primary,
                borderColor: tokens.background,
                left: Math.max(0, Math.min(trackWidth, ratio * trackWidth)) - THUMB / 2,
              },
            ]}
          />
        </View>

        <Text
          testID="motion-time"
          numberOfLines={1}
          className="text-[11px]"
          style={{ color: tokens.mutedForeground, fontVariant: ['tabular-nums'] }}
        >
          {timeLabel}
        </Text>

        <Pressable
          testID="motion-loop"
          onPress={() => setLoop((prev) => !prev)}
          hitSlop={8}
          accessibilityRole="switch"
          accessibilityState={{ checked: loop }}
          accessibilityLabel={t('configSheet.loop')}
          className="h-8 w-8 items-center justify-center rounded-full"
        >
          <Repeat size={15} color={loop ? tokens.foreground : tokens.mutedForeground} />
        </Pressable>
      </View>
    </View>
  )
}

const THUMB = 14

const styles = StyleSheet.create({
  trackTouch: {
    flex: 1,
    height: 32,
    justifyContent: 'center',
    marginHorizontal: THUMB / 2,
  },
  rail: { height: 6, borderRadius: 999, overflow: 'hidden' },
  thumb: {
    position: 'absolute',
    pointerEvents: 'none',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 3,
  },
})
