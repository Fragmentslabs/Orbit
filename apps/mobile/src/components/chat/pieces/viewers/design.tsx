/**
 * Design no celular.
 *
 * O `piece.url` de design NÃO é uma página: é o `canvas.json` do canvas, o
 * índice que o desktop grava na pasta da peça (ver
 * apps/desktop/electron/lib/design/design-canvas.ts):
 *
 *   { v: 1, title?, boards: { "<arquivo>.html": { title?, x, y, w, h } }, order: string[] }
 *
 * Cada artboard é um HTML autocontido na MESMA pasta, e `order` é a sequência
 * das telas (empilhamento, de trás para frente) — a mesma que a barra de telas
 * do desktop usa. Este viewer busca esse índice, monta a lista e abre uma tela
 * de cada vez; o HTML de cada uma sai da própria URL da peça trocando o
 * `canvas.json` do fim pelo arquivo da artboard (o token assinado é um segmento
 * do caminho e vale para a pasta inteira, então o irmão herda a autorização).
 *
 * A artboard é interativa de verdade (é um documento, com rolagem, hover e
 * toque próprios): nada é desenhado por cima dela além das barras de fora.
 */
import { AlertCircle, ChevronLeft, ChevronRight, Frame, RotateCw } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

import { PieceView } from '../../PieceView'

import type { PieceViewerProps } from './index'

/** Uma tela do canvas: o arquivo `.html` e o título que ele tem no índice. */
export interface DesignScreen {
  file: string
  title?: string
}

/** Nome do índice dentro da pasta do canvas — o fim da `piece.url`. */
const INDEX_FILE = 'canvas.json'

/**
 * Medidas do que NÃO é a tela, para o WebView receber o que sobra da janela:
 * a barra da casca (`PieceViewer`: botão de 32 + padding + borda), a barra
 * interna do `PieceView` com a margem dela, a linha das setas e a tira de
 * chips. Abaixo disso a tela não cabe e vira um selo.
 */
const SHELL_HEADER = 54
const PIECE_CHROME = 41
const NAV_ROW = 44
const STRIP_ROW = 60
const MIN_VIEW_HEIGHT = 140

function isScreenFile(file: string): boolean {
  const segments = file.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function boardTitle(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const title = (value as { title?: unknown }).title
  return typeof title === 'string' && title.trim() ? title.trim() : undefined
}

function boardXy(value: unknown): { x: number; y: number } {
  const board = (value ?? {}) as { x?: unknown; y?: unknown }
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)
  return { x: num(board.x), y: num(board.y) }
}

/**
 * O `canvas.json` (já parseado) na lista de telas, ou `[]`.
 *
 * `order` manda: é a ordem que o desktop mostra, e o celular não pode numerar as
 * telas em ordem diferente. A artboard que existe em `boards` mas ficou fora do
 * `order` (índice pela metade, escrito durante a geração) continua sendo tela —
 * entra no fim, na ordem de leitura do canvas (x, depois y) —, senão uma peça
 * com conteúdo apareceria vazia aqui.
 */
export function parseDesignCanvas(raw: unknown): DesignScreen[] {
  const canvas = (raw ?? {}) as { boards?: unknown; order?: unknown }
  const boards =
    canvas.boards && typeof canvas.boards === 'object' && !Array.isArray(canvas.boards)
      ? (canvas.boards as Record<string, unknown>)
      : {}

  const screens: DesignScreen[] = []
  const seen = new Set<string>()
  const push = (file: unknown) => {
    if (typeof file !== 'string' || !isScreenFile(file) || seen.has(file)) return
    if (!Object.prototype.hasOwnProperty.call(boards, file)) return
    seen.add(file)
    screens.push({ file, title: boardTitle(boards[file]) })
  }

  if (Array.isArray(canvas.order)) for (const file of canvas.order) push(file)

  const rest = Object.keys(boards).filter((file) => !seen.has(file) && isScreenFile(file))
  rest.sort((a, b) => {
    const left = boardXy(boards[a])
    const right = boardXy(boards[b])
    return left.x - right.x || left.y - right.y || a.localeCompare(b)
  })
  for (const file of rest) push(file)

  return screens
}

/**
 * A URL do HTML de uma artboard, derivada da URL do índice.
 *
 * O índice mora no fim do caminho (`…/design/<id>/<token>/canvas.json`), então a
 * pasta é a URL sem esse último segmento e o arquivo entra codificado — o mesmo
 * formato que o companion monta (`encodeURIComponent` por segmento). Sem
 * `canvas.json` no fim (URL já na pasta, por exemplo), o arquivo entra depois de
 * uma barra em vez de comer o último segmento: cortar o token deixaria a tela
 * sem autorização.
 */
export function artboardUrl(canvasUrl: string, file: string): string | null {
  const clean = canvasUrl.trim().split('#')[0].split('?')[0]
  const cut = clean.lastIndexOf('/')
  if (cut <= 0) return null

  const last = clean.slice(cut + 1)
  const folder =
    last === ''
      ? clean
      : last.toLowerCase() === INDEX_FILE
        ? clean.slice(0, cut + 1)
        : `${clean}/`

  const relative = file
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  return relative ? folder + relative : null
}

/** O que escrever no chip e na barra da tela: o título do índice, ou o arquivo. */
export function screenLabel(screen: DesignScreen): string {
  const title = screen.title?.trim()
  if (title) return title
  const name = screen.file.split('/').pop() ?? screen.file
  return name.replace(/\.html?$/i, '')
}

type Status = 'loading' | 'error' | 'ready'

/** Caixa centrada dos estados sem tela (carregando, erro, canvas vazio). */
function StateBox({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View testID={testID} className="flex-1 items-center justify-center gap-2 px-8">
      {children}
    </View>
  )
}

export function DesignViewer({ piece }: PieceViewerProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const { height: windowHeight } = useWindowDimensions()
  const insets = useSafeAreaInsets()

  const [status, setStatus] = useState<Status>('loading')
  const [screens, setScreens] = useState<DesignScreen[]>([])
  const [detail, setDetail] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  // Peça nova (ou "tentar de novo") recomeça do zero: nada do canvas anterior
  // sobrevive à troca de fonte. Ajuste DURANTE a renderização, o padrão do
  // React para estado derivado de prop — num efeito haveria um render
  // intermediário mostrando as telas da peça anterior.
  const sourceKey = `${piece.url}#${attempt}`
  const [seenSource, setSeenSource] = useState(sourceKey)
  if (seenSource !== sourceKey) {
    setSeenSource(sourceKey)
    setStatus('loading')
    setDetail(null)
    setScreens([])
    setSelected(null)
  }

  // O índice do canvas é a única leitura desta camada. `AbortController` porque
  // fechar a tela cheia desmonta o viewer no meio da busca, e um `setState`
  // depois disso é ruído.
  useEffect(() => {
    let alive = true
    const controller = new AbortController()

    fetch(piece.url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<unknown>
      })
      .then((json) => {
        if (!alive) return
        setScreens(parseDesignCanvas(json))
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (!alive) return
        // Token expirado, desktop desligado, canvas removido: a mesma caixa de
        // erro, com o motivo concreto embaixo e um "tentar de novo" que refaz a
        // busca (o índice pode voltar; a URL assinada, não).
        setDetail(err instanceof Error ? err.message : String(err))
        setStatus('error')
      })

    return () => {
      alive = false
      controller.abort()
    }
  }, [piece.url, attempt])

  // A tela aberta é guardada pelo NOME do arquivo, não pelo índice: um índice
  // sobrevive torto a um canvas que mudou, um nome ou está no canvas ou não
  // está.
  const index = useMemo(() => {
    if (!selected) return 0
    const found = screens.findIndex((screen) => screen.file === selected)
    return found >= 0 ? found : 0
  }, [screens, selected])

  const screen = screens[index]
  const src = screen ? artboardUrl(piece.url, screen.file) : null

  const viewHeight = Math.max(
    MIN_VIEW_HEIGHT,
    windowHeight - insets.top - insets.bottom - SHELL_HEADER - PIECE_CHROME - NAV_ROW - STRIP_ROW,
  )

  const goTo = useCallback(
    (next: number) => {
      const target = screens[Math.min(Math.max(next, 0), screens.length - 1)]
      if (target) setSelected(target.file)
    },
    [screens],
  )

  if (status === 'loading') {
    return (
      <StateBox testID="design-loading">
        <ActivityIndicator color={tokens.primary} accessibilityLabel={t('parts.preview.loading')} />
        <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
          {t('parts.preview.loading')}
        </Text>
      </StateBox>
    )
  }

  if (status === 'error') {
    return (
      <StateBox testID="design-error">
        <AlertCircle size={20} color={tokens.mutedForeground} />
        <Text className="text-center text-xs" style={{ color: tokens.mutedForeground }}>
          {t('parts.preview.error')}
        </Text>
        {detail ? (
          <Text
            numberOfLines={2}
            className="text-center text-[10px]"
            style={{ color: tokens.mutedForeground, opacity: 0.7 }}
          >
            {detail}
          </Text>
        ) : null}
        <Pressable
          testID="design-retry"
          onPress={() => setAttempt((n) => n + 1)}
          accessibilityRole="button"
          accessibilityLabel={t('parts.preview.retry')}
          hitSlop={8}
          className="mt-1 flex-row items-center gap-1 rounded-md px-2 py-1"
          style={{ backgroundColor: tokens.muted }}
        >
          <RotateCw size={12} color={tokens.foreground} />
          <Text className="text-xs" style={{ color: tokens.foreground }}>
            {t('parts.preview.retry')}
          </Text>
        </Pressable>
      </StateBox>
    )
  }

  // Canvas sem tela (índice recém-criado, peça esvaziada) ou artboard que não dá
  // para endereçar: estado vazio de verdade. Nada de WebView apontando para o
  // JSON nem de tile quebrado — esse é o bug que a galeria já teve.
  if (!screen || !src) {
    return (
      <StateBox testID="design-empty">
        <Frame size={22} color={tokens.mutedForeground} />
        <Text className="text-center text-xs" style={{ color: tokens.mutedForeground }}>
          {t('parts.preview.empty')}
        </Text>
        {screens.length === 0 ? (
          <Text className="text-[10px]" style={{ color: tokens.mutedForeground, opacity: 0.7 }}>
            {t('pieces.meta.screens', { count: 0 })}
          </Text>
        ) : null}
      </StateBox>
    )
  }

  const prev = index > 0 ? screens[index - 1] : null
  const next = index < screens.length - 1 ? screens[index + 1] : null

  return (
    <View className="flex-1">
      {/* A tela em si: só ela é montada, e a interação é toda dela. */}
      <PieceView
        src={src}
        title={screenLabel(screen)}
        poster={piece.cover}
        revision={0}
        height={viewHeight}
        expandable={false}
        loadingLabel={t('parts.preview.loading')}
        errorLabel={t('parts.preview.error')}
      />

      <View className="flex-row items-center justify-center gap-4 px-3" style={{ height: NAV_ROW }}>
        <Pressable
          testID="design-prev"
          onPress={() => goTo(index - 1)}
          disabled={!prev}
          accessibilityRole="button"
          accessibilityState={{ disabled: !prev }}
          accessibilityLabel={prev ? t('pieces.open', { title: screenLabel(prev) }) : undefined}
          hitSlop={10}
          className="h-8 w-8 items-center justify-center rounded-full"
          style={{ backgroundColor: tokens.muted, opacity: prev ? 1 : 0.4 }}
        >
          <ChevronLeft size={16} color={tokens.foreground} />
        </Pressable>

        <Text testID="design-counter" className="text-xs" style={{ color: tokens.mutedForeground }}>
          {index + 1} / {screens.length}
        </Text>

        <Pressable
          testID="design-next"
          onPress={() => goTo(index + 1)}
          disabled={!next}
          accessibilityRole="button"
          accessibilityState={{ disabled: !next }}
          accessibilityLabel={next ? t('pieces.open', { title: screenLabel(next) }) : undefined}
          hitSlop={10}
          className="h-8 w-8 items-center justify-center rounded-full"
          style={{ backgroundColor: tokens.muted, opacity: next ? 1 : 0.4 }}
        >
          <ChevronRight size={16} color={tokens.foreground} />
        </Pressable>
      </View>

      {/* O "select de telas": a tira rola na horizontal, a tela aberta fica
          marcada, e um toque pula direto para ela. A faixa do indicador em casa
          entra na altura da tira (a tela já descontou ela da própria altura),
          senão os chips ficariam por baixo dele. */}
      <ScrollView
        testID="design-screens"
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ height: STRIP_ROW + insets.bottom }}
        contentContainerStyle={{
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 12,
          paddingBottom: insets.bottom,
        }}
      >
        {screens.map((item, i) => {
          const active = i === index
          const label = screenLabel(item)
          return (
            <Pressable
              key={item.file}
              testID={`design-screen-${i}`}
              onPress={() => setSelected(item.file)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t('pieces.open', { title: label })}
              className="rounded-full border px-2.5 py-1"
              style={{
                backgroundColor: active ? withAlpha(tokens.primary, 0.18) : tokens.card,
                borderColor: active ? tokens.primary : tokens.border,
              }}
            >
              <Text
                numberOfLines={1}
                className="text-[11px]"
                style={{ color: active ? tokens.foreground : tokens.mutedForeground, maxWidth: 140 }}
              >
                {label}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}
