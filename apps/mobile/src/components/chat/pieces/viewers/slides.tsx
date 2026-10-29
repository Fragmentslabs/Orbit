/**
 * Slides no celular — o deck paginado, um slide por tela.
 *
 * COMO UM DECK É MONTADO (lido em `apps/desktop/electron/lib/slides`):
 *
 * - `deck-template.ts` escreve N `<section class="slide">` em sequência no
 *   `<body>`: no FONTE os slides ficam **empilhados**, um embaixo do outro, e o
 *   documento não tem navegação nenhuma.
 * - `slides-runtime.ts` é quem monta o palco: recolhe as seções, joga todas
 *   dentro de `.orbit-slides-stage` e as deixa **sobrepostas**
 *   (`position:absolute`, uma `.is-current` visível por vez), escala 1280×720
 *   (ou o que o `<meta name="orbit-slides">` declarar) para caber na janela e
 *   obedece teclado, clique e `postMessage`. Quem pagina é o APP, nunca o
 *   documento.
 *
 * O CAMINHO DO CELULAR NÃO TEM ESSE RUNTIME. `companion-assets.ts` serve o
 * arquivo do disco como está (só as URLs de fonte são reescritas); o runtime
 * existe só dentro do protocolo `orbit-slides://` do Electron
 * (`slides-store.ts`). O WebView recebe, portanto, o deck EMPILHADO e sem
 * escala: numa tela de 390 pontos, seções desenhadas para 1280 ficam
 * espremidas, e não há como andar entre elas.
 *
 * É o caso (2) da pergunta de sempre: sem palco, os slides não são páginas
 * roláveis, são camadas que o app precisa virar. Por isso este viewer faz o
 * que o desktop faz, com as duas metades que o app tem:
 *
 * - o PALCO entra por injeção (`onReady` → `injectJavaScript`, o canal que o
 *   `PieceView` expõe justamente para "seek, paging"): o `src={piece.url}`
 *   continua sendo o documento do deck — assets relativos, token na pasta e
 *   CSP ficam intactos —, e o script recolhe as seções, esconde o empilhado e
 *   monta as camadas no mesmo bloco síncrono, sem piscar;
 * - a NAVEGAÇÃO é do app: as setas laterais e o contador são RN, e mandam
 *   `window.orbitSlides.go(n)` pelo mesmo `inject`. O swipe fica dentro do
 *   documento, que é o único lugar que recebe o toque por cima do WebView.
 *
 * O documento devolve o índice por `onMessage` (`ready`/`change`/`empty`), que
 * é o que mantém contador e setas em sincronia com o slide que está na tela.
 *
 * A API do palco (`window.orbitSlides.go/next/prev`, `data-index`,
 * `.is-current`) é a mesma do runtime do desktop de propósito: um dia o
 * `companion-assets` injeta o runtime de verdade e este script vira só o
 * fallback do celular.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { ChevronLeft, ChevronRight, Presentation } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

import { PieceView } from '../../PieceView'

import type { PieceViewerProps } from './index'

/** Marca das mensagens da ponte, a mesma do runtime do desktop (`SLIDES_SOURCE`). */
export const SLIDES_SOURCE = 'orbit-slides'

/**
 * Alturas fixas do que não é nosso: a barra do `PieceViewer` (h-8 do botão +
 * py-2.5 + a borda) e o que o `PieceView` põe em volta do WebView (a barra do
 * título, a margem `mt-2` e as bordas). Somadas ao inset do topo, é o que sobra
 * de corpo para o deck.
 */
const VIEWER_HEADER_HEIGHT = 53
const PIECE_CHROME_HEIGHT = 45

/** Lado do botão da seta: o alvo de toque confortável (44pt) + `hitSlop`. */
const ARROW_SIZE = 44

type DeckStatus = 'loading' | 'ready' | 'error' | 'empty'

/** O que o documento do deck conta para o app. */
export interface SlidesMessage {
  type: 'ready' | 'change' | 'empty'
  index?: number
  total?: number
}

/** A mensagem do deck, ou `null` quando não é nossa (ou não é JSON). */
export function readSlidesMessage(data: string): SlidesMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const message = parsed as Record<string, unknown>
  if (message.source !== SLIDES_SOURCE) return null
  const type = message.type
  if (type !== 'ready' && type !== 'change' && type !== 'empty') return null
  const toIndex = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined
  const index = toIndex(message.index)
  const total = toIndex(message.total)
  return {
    type,
    ...(index === undefined ? {} : { index }),
    ...(total === undefined || total <= 0 ? {} : { total }),
  }
}

/**
 * A geometria do palco. Só descreve camada e escala — cor de deck continua
 * sendo do deck; o que é do app aqui é a moldura em volta do 16:9
 * (`--orbit-bg`, preenchido pelo tema).
 */
const STAGE_CSS = `
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:var(--orbit-bg)}
#orbit-slides-root{position:fixed;inset:0;overflow:hidden;background:var(--orbit-bg);z-index:2147483000}
.orbit-slides-stage{position:absolute;left:50%;top:50%;transform-origin:center center}
.orbit-slides-stage>.orbit-slide{position:absolute;inset:0;width:100%;height:100%;visibility:hidden;opacity:0;pointer-events:none}
.orbit-slides-stage>.orbit-slide.is-current{visibility:visible;opacity:1;pointer-events:auto}
.orbit-slides-stage aside.notes,.orbit-slides-stage [data-notes]{display:none}
`.trim()

/**
 * O palco injetado no documento do deck — a metade que falta no celular.
 *
 * Roda no `onLoadEnd` do WebView, com o documento já lido (por isso não há
 * `DOMContentLoaded` aqui), e é idempotente: um retry remonta o WebView, mas
 * dois injects na mesma página não podem montar dois palcos.
 *
 * Sem template literals lá dentro de propósito: este texto é uma string TS, e
 * um `${` no meio dela quebraria a montagem (a mesma cautela de
 * `slides-runtime.ts`). `__ORBIT_SLIDES_CONFIG__` é trocado em `deckStageSource`.
 */
const STAGE_RUNTIME = `(function () {
  if (window.__orbitSlidesMobile) return
  window.__orbitSlidesMobile = true

  var SOURCE = 'orbit-slides'
  var config = __ORBIT_SLIDES_CONFIG__

  function post(message) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          source: SOURCE,
          type: message.type,
          index: message.index,
          total: message.total
        }))
      }
    } catch (error) {}
  }

  var width = 1280
  var height = 720
  var meta = document.querySelector('meta[name="orbit-slides"]')
  if (meta) {
    var pairs = String(meta.getAttribute('content') || '').split(/[,;]/)
    for (var p = 0; p < pairs.length; p++) {
      var pair = pairs[p]
      var at = pair.indexOf('=')
      if (at < 0) continue
      var key = pair.slice(0, at).trim()
      var num = Number(pair.slice(at + 1).trim())
      if (!isFinite(num) || num <= 0) continue
      if (key === 'width') width = Math.round(num)
      if (key === 'height') height = Math.round(num)
    }
  }

  // Só as seções de TOPO: um .slide dentro de outro (uma capa que repete o
  // padrão) não é uma parada da apresentação.
  var nodes = document.querySelectorAll('.slide')
  var sections = []
  for (var i = 0; i < nodes.length; i++) {
    if (!nodes[i].closest('.orbit-slides-stage')) sections.push(nodes[i])
  }
  if (!sections.length) {
    post({ type: 'empty' })
    return
  }

  // Nada de piscar o deck empilhado: esconde, monta o palco e mostra tudo no
  // MESMO bloco síncrono, então o navegador não pinta no meio.
  document.documentElement.style.visibility = 'hidden'

  var style = document.createElement('style')
  style.textContent = config.css
  document.head.appendChild(style)

  var root = document.createElement('div')
  root.id = 'orbit-slides-root'
  var stage = document.createElement('div')
  stage.className = 'orbit-slides-stage'
  stage.style.width = width + 'px'
  stage.style.height = height + 'px'
  root.appendChild(stage)
  document.body.appendChild(root)

  for (var s = 0; s < sections.length; s++) {
    var section = sections[s]
    section.classList.add('orbit-slide')
    // O deck pode desenhar o próprio número com [data-index] (o tema da casa
    // usa isto no canto do slide).
    section.setAttribute('data-index', String(s + 1))
    stage.appendChild(section)
  }

  var index = 0

  function paint() {
    for (var k = 0; k < sections.length; k++) {
      if (k === index) sections[k].classList.add('is-current')
      else sections[k].classList.remove('is-current')
    }
  }

  function go(value) {
    var target = Math.max(0, Math.min(sections.length - 1, Math.round(Number(value)) || 0))
    if (target === index) return
    index = target
    paint()
    post({ type: 'change', index: index, total: sections.length })
  }

  function fit() {
    var vw = window.innerWidth || 1
    var vh = window.innerHeight || 1
    var scale = Math.min(vw / width, vh / height)
    stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')'
    // translate ANTES do scale: o palco pode ser maior que a janela, e um item
    // maior que o container não fica centralizado — ele vaza para a direita.
    stage.style.transformOrigin = 'center center'
  }

  // Swipe horizontal: o palco ocupa a tela toda, então ele é o alvo natural (e
  // é o único caminho de toque que o WebView deixa para o documento). O limite
  // de 40px e a razão contra o eixo Y separam swipe de rolagem de um toque.
  var startX = 0
  var startY = 0
  var startAt = 0
  root.addEventListener('touchstart', function (event) {
    var touch = event.changedTouches && event.changedTouches[0]
    if (!touch) return
    startX = touch.clientX
    startY = touch.clientY
    startAt = Date.now()
  }, { passive: true })
  root.addEventListener('touchend', function (event) {
    var touch = event.changedTouches && event.changedTouches[0]
    if (!touch) return
    var dx = touch.clientX - startX
    var dy = touch.clientY - startY
    if (Date.now() - startAt > 900) return
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.4) return
    go(index + (dx < 0 ? 1 : -1))
  }, { passive: true })

  // A API que o app chama por injectJavaScript — os mesmos nomes do runtime
  // do desktop, para o dia em que ele for injetado no servidor.
  window.orbitSlides = {
    version: 1,
    get index() { return index },
    total: sections.length,
    go: go,
    next: function () { go(index + 1) },
    prev: function () { go(index - 1) }
  }

  window.addEventListener('resize', fit)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit).catch(function () {})

  paint()
  fit()
  document.documentElement.style.visibility = ''
  post({ type: 'ready', index: 0, total: sections.length })
})()`

/**
 * O que é injetado no WebView: o CSS do palco (com a cor do app) e o script,
 * numa chamada só. Puro e testável.
 */
export function deckStageSource(background: string): string {
  const css = `:root{--orbit-bg:${background}}${STAGE_CSS}`
  // `</script>` não aparece aqui (é `injectJavaScript`, não um `<script>`), mas
  // o `<` do CSS viraria ruído no JSON: escapar mantém o texto opaco.
  const config = JSON.stringify({ css }).replace(/</g, '\\u003c')
  return STAGE_RUNTIME.replace('__ORBIT_SLIDES_CONFIG__', config)
}

/** Seta lateral sobreposta ao deck. `disabled` nas pontas: não há para onde ir. */
function SlideArrow({
  side,
  label,
  color,
  background,
  border,
  disabled,
  onPress,
}: {
  side: 'previous' | 'next'
  label: string
  color: string
  background: string
  border: string
  disabled: boolean
  onPress: () => void
}) {
  const Icon = side === 'previous' ? ChevronLeft : ChevronRight
  const position: StyleProp<ViewStyle> =
    side === 'previous' ? styles.arrowLeft : styles.arrowRight

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={`slides-${side}`}
      style={[
        styles.arrow,
        position,
        { backgroundColor: background, borderColor: border },
        disabled ? styles.arrowDisabled : null,
      ]}
    >
      <Icon size={20} color={color} />
    </Pressable>
  )
}

export function SlidesViewer({ piece }: PieceViewerProps) {
  const { height: windowHeight } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const background = tokens.background
  const { t } = useTranslation()

  const [status, setStatus] = useState<DeckStatus>('loading')
  const [index, setIndex] = useState(0)
  const [total, setTotal] = useState(0)

  // O `inject` do WebView que acabou de carregar. Ref, não estado: mandar um
  // comando para o deck não deve renderizar nada.
  const inject = useRef<((js: string) => void) | null>(null)

  // O fundo do palco vem por ref, não por closure: o React Compiler não consegue
  // preservar um `useCallback` que fecha sobre um valor derivado de
  // `getThemeTokens(...)`, e o callback precisa continuar o mesmo a cada carga.
  // O ref só é lido na hora do carregamento (nunca no render).
  const backgroundRef = useRef(background)
  useEffect(() => {
    backgroundRef.current = background
  }, [background])

  // Todo carregamento passa por aqui — inclusive o de "tentar de novo", que
  // remonta o WebView e portanto perde o palco da página anterior.
  const handleReady = useCallback((send: (js: string) => void) => {
    inject.current = send
    send(deckStageSource(backgroundRef.current))
  }, [])

  const handleMessage = useCallback((data: string) => {
    const message = readSlidesMessage(data)
    if (!message) return
    if (message.type === 'empty') {
      setStatus('empty')
      return
    }
    if (message.total) setTotal(message.total)
    if (message.index !== undefined) setIndex(message.index)
    setStatus('ready')
  }, [])

  const goTo = useCallback((target: number) => {
    // O palco é de quem carregou; sem ele (página ainda carregando, inject não
    // chegou) a seta não pode prometer um slide que não vai aparecer.
    inject.current?.(`window.orbitSlides && window.orbitSlides.go(${target})`)
  }, [])

  // Corpo do deck: o que sobra da tela depois do cabeçalho do `PieceViewer` e
  // da moldura do `PieceView` (que não é nossa e não dá para esconder).
  const bodyHeight = Math.max(
    240,
    windowHeight - insets.top - VIEWER_HEADER_HEIGHT - PIECE_CHROME_HEIGHT,
  )

  const ready = status === 'ready'
  const counter =
    ready && total > 0
      ? t('pieces.slides.counter', {
          index: index + 1,
          count: total,
          // A chave ainda não existe nos locales: o padrão é o próprio formato,
          // e no dia em que ela nascer o texto passa a vir traduzido.
          defaultValue: '{{index}} / {{count}}',
        })
      : null

  // Deck vazio (nenhum `.slide` no documento): o palco não tem o que montar e o
  // WebView sai de cena — um deck que não é deck não é uma tela em branco.
  if (status === 'empty') {
    return (
      <View style={styles.center} testID="slides-empty">
        <Presentation size={22} color={tokens.mutedForeground} />
        <Text className="text-sm font-medium" style={{ color: tokens.foreground }}>
          {t('parts.preview.empty')}
        </Text>
        <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
          {t('pieces.meta.slides', { count: 0 })}
        </Text>
      </View>
    )
  }

  return (
    <View className="flex-1" style={styles.stage}>
      <PieceView
        src={piece.url}
        // Enquanto o total é desconhecido a barra fica sem texto: repetir o
        // título aqui seria dizer duas vezes o que o cabeçalho já diz.
        title={total > 0 ? t('pieces.meta.slides', { count: total }) : ''}
        poster={piece.cover}
        revision={0}
        height={bodyHeight}
        expandable={false}
        onMessage={handleMessage}
        onError={() => setStatus('error')}
        onReady={handleReady}
      />

      {ready && total > 1 ? (
        <>
          <SlideArrow
            side="previous"
            label={t('pieces.slides.previous', { defaultValue: 'Slide anterior' })}
            color={tokens.foreground}
            background={withAlpha(tokens.background, 0.74)}
            border={tokens.border}
            disabled={index === 0}
            onPress={() => goTo(index - 1)}
          />
          <SlideArrow
            side="next"
            label={t('pieces.slides.next', { defaultValue: 'Próximo slide' })}
            color={tokens.foreground}
            background={withAlpha(tokens.background, 0.74)}
            border={tokens.border}
            disabled={index >= total - 1}
            onPress={() => goTo(index + 1)}
          />
        </>
      ) : null}

      {counter ? (
        // Sobre o deck, no rodapé: ponteiro desligado, senão o contador come o
        // toque que era do swipe.
        <View pointerEvents="none" style={styles.counterRow}>
          <View
            style={[
              styles.counter,
              { backgroundColor: withAlpha(tokens.background, 0.78), borderColor: tokens.border },
            ]}
          >
            <Text
              className="text-[11px] font-medium"
              style={{ color: tokens.mutedForeground }}
              testID="slides-counter"
            >
              {counter}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  stage: { position: 'relative' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 24 },
  arrow: {
    position: 'absolute',
    top: '50%',
    marginTop: -ARROW_SIZE / 2,
    width: ARROW_SIZE,
    height: ARROW_SIZE,
    borderRadius: ARROW_SIZE / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowLeft: { left: 6 },
  arrowRight: { right: 6 },
  // Nas pontas a seta continua visível (dá para ver que existe um lado), mas
  // apagada e sem toque.
  arrowDisabled: { opacity: 0.28 },
  counterRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingBottom: 12,
  },
  counter: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
})
