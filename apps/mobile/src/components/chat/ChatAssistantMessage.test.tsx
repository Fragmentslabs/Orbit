import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage, MessagePart } from '@orbit/shared'
// Os mocks abaixo são içados pelo vitest acima destes imports — a ordem aqui é
// só de leitura (o `import/first` reclama de import depois de `vi.mock`).
import { ChatAssistantMessage } from './ChatAssistantMessage'
import { PieceView } from './PieceView'

/**
 * Parts de mídia e peça na resposta do assistente.
 *
 * O que se prova: áudio, vídeo, artefato e documento RENDERIZAM (antes áudio e
 * vídeo caíam no `default` do switch e sumiam sem aviso, e artefato/documento
 * viravam um cartão "disponível só no desktop"); uma part com `src` vazio
 * degrada num card, sem crash; e o artefato abre pelo PieceView, com tela cheia.
 *
 * Runner: o vitest do app com `react-native` resolvido para `react-native-web`
 * (ver vitest.config.ts), no jsdom — são os mesmos componentes, renderizados no
 * DOM. Só os módulos nativos que o componente toca são substituídos.
 */

// ── Módulos nativos ─────────────────────────────────────────────────────────

// O código do Expo (expo-modules-core, arrastado por expo-image/Clipboard) lê
// `__DEV__`, que existe no bundle do RN e não no Node. Precisa estar definido
// antes de qualquer import — daí o `hoisted`.
vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__DEV__ = false
})

const audio = vi.hoisted(() => ({
  player: { play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(async () => {}) },
  status: {
    playing: false,
    isLoaded: true,
    duration: 12,
    currentTime: 0,
    didJustFinish: false,
    error: null as string | null,
  },
}))

vi.mock('expo-audio', () => ({
  useAudioPlayer: () => audio.player,
  useAudioPlayerStatus: () => audio.status,
}))

vi.mock('expo-video', async () => {
  const React = await import('react')
  const player = { status: 'readyToPlay' as string, pause: vi.fn() }
  return {
    useVideoPlayer: () => player,
    VideoView: () => React.createElement('div', { 'data-testid': 'video-view' }),
  }
})

vi.mock('expo', () => ({ useEvent: () => ({ status: 'readyToPlay' }) }))

/** O WebView do PieceView: guarda as props para o teste poder simular falha. */
const webviews = vi.hoisted(() => ({ props: [] as Record<string, any>[] }))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  return {
    WebView: (props: Record<string, any>) => {
      webviews.props.push(props)
      return React.createElement('div', {
        'data-testid': props.testID,
        'data-uri': (props.source as { uri?: string } | undefined)?.uri,
      })
    },
  }
})

vi.mock('expo-image', async () => {
  const React = await import('react')
  return {
    Image: (props: { source?: unknown }) =>
      React.createElement('div', {
        'data-testid': 'image',
        'data-source': typeof props.source === 'string' ? props.source : undefined,
      }),
  }
})

vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => ({})) }))
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => false, shareAsync: vi.fn(async () => {}) }))
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: '/tmp/',
  downloadAsync: vi.fn(async () => ({ uri: '/tmp/doc.html' })),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

// Ícones: o mock global do test-env é um Proxy, e o vitest valida exports
// nomeados — aqui os nomes usados por estes componentes são explícitos.
vi.mock('lucide-react-native', async () => {
  const React = await import('react')
  const Icon = () => React.createElement('i')
  return {
    AlertCircle: Icon,
    Bot: Icon,
    Brain: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    Download: Icon,
    ExternalLink: Icon,
    Eye: Icon,
    Globe: Icon,
    Link: Icon,
    Maximize2: Icon,
    Pause: Icon,
    Play: Icon,
    RotateCw: Icon,
    Search: Icon,
    Sparkles: Icon,
    Terminal: Icon,
    X: Icon,
  }
})

// Rótulos: a tela é pt-BR e o teste não depende do bundle de i18n.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }),
}))

// Tema: o store real toca storage do aparelho.
vi.mock('~/stores/theme-store', () => ({
  useThemeStore: (selector: (state: { resolved: string }) => unknown) => selector({ resolved: 'dark' }),
}))

// Irmãos da bolha: não fazem parte desta tarefa e arrastariam stores e rede
// para dentro do teste.
vi.mock('./AssistantMarkdown', () => ({ AssistantMarkdown: () => null }))
vi.mock('./TodoChecklist', () => ({ TodoChecklist: () => null }))
vi.mock('./MessageActions', () => ({ MessageActions: () => null }))
vi.mock('./Attachment', () => ({ MessageAttachment: () => null }))
vi.mock('./ImageLightbox', () => ({ ImageLightbox: () => null }))
vi.mock('./McpProposalCard', () => ({ McpProposalCard: () => null }))
vi.mock('./SkillProposalCard', () => ({ SkillProposalCard: () => null }))
vi.mock('./SubAgentCard', () => ({ SubAgentCard: () => null }))
vi.mock('./ReplyBar', () => ({ useReplyLabel: () => (role: string) => role }))
vi.mock('~/components/memories/MemoryChip', () => ({ MemoryChip: () => null }))
vi.mock('~/components/ai/Shimmer', () => ({
  Shimmer: (props: { children?: unknown }) => props.children ?? null,
}))

// ── Helpers ─────────────────────────────────────────────────────────────────

const AUDIO_SRC = 'http://192.168.0.10:3848/api/file/audio/aud_abc/tok-audio'
const VIDEO_SRC = 'http://192.168.0.10:3848/api/file/video/vid_abc/tok-video'
const ARTIFACT_SRC = 'http://192.168.0.10:3848/api/file/artifact/art_abc.html/tok-artifact'
const DOC_SRC = 'http://192.168.0.10:3848/api/file/artifact/doc_abc.html/tok-artifact'

function message(parts: MessagePart[]): ChatMessage {
  return { id: 'msg-1', role: 'assistant', parts, createdAt: Date.now(), completedAt: Date.now() }
}

function renderMessage(parts: MessagePart[]) {
  return render(<ChatAssistantMessage message={message(parts)} />)
}

const audioPart = (src: string): MessagePart =>
  ({ id: 'a1', type: 'audio', src, title: 'Resumo em voz', durationMs: 12_000 }) as MessagePart

const videoPart = (src: string): MessagePart =>
  ({ id: 'v1', type: 'video', src, title: 'Corte final' }) as MessagePart

const artifactPart = (src: string): MessagePart =>
  ({
    id: 'art1',
    type: 'artifact',
    src,
    artifactId: 'art_abc.html',
    title: 'Dashboard',
    thumb: 'http://192.168.0.10:3848/api/file/artifact/art_abc.png/tok-artifact',
    revision: 2,
  }) as MessagePart

const documentPart = (previewSrc: string): MessagePart =>
  ({
    id: 'doc1',
    type: 'document',
    documentId: 'doc_abc.md',
    title: 'Relatório trimestral',
    previewSrc,
    formats: ['pdf'],
  }) as MessagePart

beforeEach(() => {
  webviews.props = []
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ── Áudio e vídeo ───────────────────────────────────────────────────────────

describe('ChatAssistantMessage — áudio e vídeo', () => {
  it('áudio com src vira player inline, com título e botão de tocar', () => {
    renderMessage([audioPart(AUDIO_SRC)])

    expect(screen.getByTestId('audio-part')).toBeTruthy()
    expect(screen.getByText('Resumo em voz')).toBeTruthy()
    expect(screen.getByLabelText('parts.audio.play')).toBeTruthy()
    expect(screen.queryByTestId('audio-part-unavailable')).toBeNull()
  })

  it('o play do áudio chega ao player do expo-audio', () => {
    renderMessage([audioPart(AUDIO_SRC)])
    fireEvent.click(screen.getByLabelText('parts.audio.play'))
    expect(audio.player.play).toHaveBeenCalled()
  })

  it('vídeo com src vira player 16:9 com controles nativos', () => {
    renderMessage([videoPart(VIDEO_SRC)])

    expect(screen.getByTestId('video-part')).toBeTruthy()
    expect(screen.getByTestId('video-view')).toBeTruthy()
    expect(screen.queryByTestId('video-part-unavailable')).toBeNull()
  })
})

// ── Artefato e documento ────────────────────────────────────────────────────

describe('ChatAssistantMessage — artefato', () => {
  it('abre o PieceView com a URL que veio do desktop, sem montar nada', () => {
    renderMessage([artifactPart(ARTIFACT_SRC)])

    const host = screen.getByTestId('piece-view')
    expect(host.getAttribute('data-uri')).toBe(ARTIFACT_SRC)
    expect(screen.getByText('Dashboard')).toBeTruthy()
    // O cartão antigo de "só no desktop" não existe mais.
    expect(screen.queryByText('chatAssistant.artifactDesktopOnly')).toBeNull()
  })

  it('expande para tela cheia', () => {
    renderMessage([artifactPart(ARTIFACT_SRC)])

    expect(screen.queryByTestId('piece-view-fullscreen')).toBeNull()
    fireEvent.click(screen.getByLabelText('parts.preview.expand'))
    expect(screen.getByTestId('piece-view-fullscreen')).toBeTruthy()
  })

  it('falha de carga vira erro discreto com "tentar de novo", sem derrubar a bolha', () => {
    renderMessage([artifactPart(ARTIFACT_SRC)])

    act(() => {
      webviews.props.at(-1)?.onError({ nativeEvent: { description: 'sem rede' } })
    })

    expect(screen.getByText('parts.artifact.error')).toBeTruthy()
    expect(screen.getByText('sem rede')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('parts.preview.retry'))
    expect(screen.queryByText('parts.artifact.error')).toBeNull()
    expect(screen.getByTestId('piece-view')).toBeTruthy()
  })
})

describe('ChatAssistantMessage — documento', () => {
  it('renderiza a prévia e oferece abrir e baixar o arquivo', () => {
    renderMessage([documentPart(DOC_SRC)])

    const host = screen.getByTestId('piece-view')
    expect(host.getAttribute('data-uri')).toBe(DOC_SRC)
    expect(screen.getByText('Relatório trimestral')).toBeTruthy()
    expect(screen.getByText('parts.document.open')).toBeTruthy()
    expect(screen.getByText('parts.document.download')).toBeTruthy()
    expect(screen.queryByText('chatAssistant.documentDesktopOnly')).toBeNull()
  })

  it('"Abrir" entrega a URL do preview ao navegador do sistema', async () => {
    // O runner resolve `react-native` para `react-native-web`, então
    // Platform.OS é 'web' e o componente abre pela janela do navegador. No
    // aparelho é o expo-web-browser que recebe a mesma URL — o que se verifica
    // aqui é que o clique chega nela, sem URL montada no meio.
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderMessage([documentPart(DOC_SRC)])

    await act(async () => {
      fireEvent.click(screen.getByText('parts.document.open'))
    })

    expect(open).toHaveBeenCalledWith(DOC_SRC, '_blank')
    open.mockRestore()
  })
})

// ── Degradação ──────────────────────────────────────────────────────────────

describe('ChatAssistantMessage — part com src vazio', () => {
  it('áudio e vídeo degradam para um card com o título, sem crash', () => {
    renderMessage([audioPart(''), videoPart('')])

    expect(screen.getByTestId('audio-part-unavailable')).toBeTruthy()
    expect(screen.getByTestId('video-part-unavailable')).toBeTruthy()
    expect(screen.getByText('parts.audio.unavailable')).toBeTruthy()
    expect(screen.getByText('parts.video.unavailable')).toBeTruthy()
  })

  it('artefato e documento degradam para o card de prévia indisponível', () => {
    renderMessage([artifactPart(''), documentPart('')])

    // Nenhum WebView montado — não há URL para pedir.
    expect(screen.queryByTestId('piece-view')).toBeNull()
    expect(screen.getByText('parts.artifact.empty')).toBeTruthy()
    expect(screen.getByText('parts.document.empty')).toBeTruthy()
    // O título continua visível: o texto do assistente pode falar dele.
    expect(screen.getByText('Dashboard')).toBeTruthy()
    expect(screen.getByText('Relatório trimestral')).toBeTruthy()
  })
})

// ── PieceView isolado ───────────────────────────────────────────────────────

describe('PieceView', () => {
  it('mostra o poster enquanto carrega e o esconde quando a página fica pronta', () => {
    const poster = 'http://192.168.0.10:3848/api/file/artifact/art_abc.png/tok-artifact'
    render(<PieceView src={ARTIFACT_SRC} title="Peça" poster={poster} />)

    expect(screen.getByTestId('image').getAttribute('data-source')).toBe(poster)

    act(() => {
      webviews.props.at(-1)?.onLoadEnd()
    })

    expect(screen.queryByTestId('image')).toBeNull()
  })

  it('não deixa a tela cheia nascer aberta', () => {
    render(<PieceView src={ARTIFACT_SRC} title="Peça" />)
    expect(screen.queryByTestId('piece-view-fullscreen')).toBeNull()
  })
})
