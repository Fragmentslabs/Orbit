import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage, MessagePart } from '@orbit/shared'
// The mocks below are hoisted by vitest above these imports — the order here is
// only for reading (the `import/first` rule complains about an import after `vi.mock`).
import { ChatAssistantMessage } from './ChatAssistantMessage'
import { PieceView } from './PieceView'

/**
 * Media and piece parts in the assistant answer.
 *
 * What is proven: audio, video, artifact and document RENDER (before, audio and
 * video fell into the `default` of the switch and vanished without warning, and artifact/document
 * became a card "available only on the desktop"); a part with an empty `src`
 * degrades into a card, without a crash; and the artifact opens through PieceView, with full screen.
 *
 * Runner: the app vitest with `react-native` resolved to `react-native-web`
 * (see vitest.config.ts), in jsdom — they are the same components, rendered in the
 * DOM. Only the native modules the component touches are replaced.
 */

// ── Native modules ──────────────────────────────────────────────────────────

// The Expo code (expo-modules-core, dragged in by expo-image/Clipboard) reads
// `__DEV__`, which exists in the RN bundle and not in Node. It needs to be defined
// before any import — hence the `hoisted`.
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

/** The WebView of PieceView: stores the props so the test can simulate a failure. */
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

// Icons: the global mock of test-env is a Proxy, and vitest validates named
// exports — here the names used by these components are explicit.
vi.mock('lucide-react-native', async () => {
  const React = await import('react')
  const Icon = () => React.createElement('i')
  return {
    AlertCircle: Icon,
    Bot: Icon,
    Brain: Icon,
    // Icons of the piece card (motion, design, slides).
    Film: Icon,
    Frame: Icon,
    Presentation: Icon,
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

// Labels: the screen is pt-BR and the test does not depend on the i18n bundle.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }),
}))

// Theme: the real store touches the device storage.
vi.mock('~/stores/theme-store', () => ({
  useThemeStore: (selector: (state: { resolved: string }) => unknown) => selector({ resolved: 'dark' }),
}))

// Siblings of the bubble: they are not part of this task and would drag stores and network
// into the test.
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
  ({ id: 'a1', type: 'audio', src, title: 'Summary as audio', durationMs: 12_000 }) as MessagePart

const videoPart = (src: string): MessagePart =>
  ({ id: 'v1', type: 'video', src, title: 'Final cut' }) as MessagePart

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
    title: 'Quarterly report',
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

// ── Audio and video ─────────────────────────────────────────────────────────

describe('ChatAssistantMessage — audio and video', () => {
  it('audio with src becomes an inline player, with a title and a play button', () => {
    renderMessage([audioPart(AUDIO_SRC)])

    expect(screen.getByTestId('audio-part')).toBeTruthy()
    expect(screen.getByText('Summary as audio')).toBeTruthy()
    expect(screen.getByLabelText('parts.audio.play')).toBeTruthy()
    expect(screen.queryByTestId('audio-part-unavailable')).toBeNull()
  })

  it('the audio play reaches the expo-audio player', () => {
    renderMessage([audioPart(AUDIO_SRC)])
    fireEvent.click(screen.getByLabelText('parts.audio.play'))
    expect(audio.player.play).toHaveBeenCalled()
  })

  it('video with src becomes a 16:9 player with native controls', () => {
    renderMessage([videoPart(VIDEO_SRC)])

    expect(screen.getByTestId('video-part')).toBeTruthy()
    expect(screen.getByTestId('video-view')).toBeTruthy()
    expect(screen.queryByTestId('video-part-unavailable')).toBeNull()
  })
})

// ── Artifact and document ───────────────────────────────────────────────────

describe('ChatAssistantMessage — artifact', () => {
  it('opens the PieceView with the URL that came from the desktop, assembling nothing', () => {
    renderMessage([artifactPart(ARTIFACT_SRC)])

    const host = screen.getByTestId('piece-view')
    expect(host.getAttribute('data-uri')).toBe(ARTIFACT_SRC)
    expect(screen.getByText('Dashboard')).toBeTruthy()
    // The old "only on the desktop" card does not exist anymore.
    expect(screen.queryByText('chatAssistant.artifactDesktopOnly')).toBeNull()
  })

  it('tells the page which theme is in force before it paints, instead of the system one', () => {
    renderMessage([artifactPart(ARTIFACT_SRC)])

    // The token layer served by the desktop follows `prefers-color-scheme`; the app's
    // theme (dark, here) is the one that has to win — otherwise an artifact opens in the
    // opposite palette and the text of a light page lands on the dark WebView.
    const injected = String(webviews.props.at(-1)?.injectedJavaScriptBeforeContentLoaded ?? '')
    expect(injected).toContain("'orbit-dark'")
    expect(injected).toContain('document.documentElement')
  })

  it('expands to fullscreen', () => {
    renderMessage([artifactPart(ARTIFACT_SRC)])

    expect(screen.queryByTestId('piece-view-fullscreen')).toBeNull()
    fireEvent.click(screen.getByLabelText('parts.preview.expand'))
    expect(screen.getByTestId('piece-view-fullscreen')).toBeTruthy()
  })

  it('a load failure becomes a discreet error with "try again", without taking the bubble down', () => {
    renderMessage([artifactPart(ARTIFACT_SRC)])

    act(() => {
      webviews.props.at(-1)?.onError({ nativeEvent: { description: 'no network' } })
    })

    expect(screen.getByText('parts.artifact.error')).toBeTruthy()
    expect(screen.getByText('no network')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('parts.preview.retry'))
    expect(screen.queryByText('parts.artifact.error')).toBeNull()
    expect(screen.getByTestId('piece-view')).toBeTruthy()
  })
})

describe('ChatAssistantMessage — document', () => {
  it('renders the preview and offers to open and download the file', () => {
    renderMessage([documentPart(DOC_SRC)])

    const host = screen.getByTestId('piece-view')
    expect(host.getAttribute('data-uri')).toBe(DOC_SRC)
    expect(screen.getByText('Quarterly report')).toBeTruthy()
    expect(screen.getByText('parts.document.open')).toBeTruthy()
    expect(screen.getByText('parts.document.download')).toBeTruthy()
    expect(screen.queryByText('chatAssistant.documentDesktopOnly')).toBeNull()
  })

  it('"Open" hands the preview URL to the system browser', async () => {
    // The runner resolves `react-native` to `react-native-web`, so
    // Platform.OS is 'web' and the component opens through the browser window. On the
    // device it is expo-web-browser that receives the same URL — what is verified
    // here is that the click reaches it, with no URL assembled in between.
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderMessage([documentPart(DOC_SRC)])

    await act(async () => {
      fireEvent.click(screen.getByText('parts.document.open'))
    })

    expect(open).toHaveBeenCalledWith(DOC_SRC, '_blank')
    open.mockRestore()
  })
})

// ── Summary view (the only one on the phone) ────────────────────────────────

describe('ChatAssistantMessage — summary view', () => {
  it('folds every reasoning pass and the separated actions into one accordion each', () => {
    renderMessage([
      { id: 'r1', type: 'reasoning', text: 'primeiro', state: 'done', durationMs: 1000 },
      { id: 't1', type: 'tool', tool: 'read', state: 'done' },
      { id: 'r2', type: 'reasoning', text: 'segundo', state: 'done', durationMs: 2000 },
      { id: 't2', type: 'tool', tool: 'bash', state: 'done' },
      { id: 'x', type: 'text', text: 'resposta', state: 'done' },
    ] as MessagePart[])

    // One reasoning label for the whole turn (the seconds of both passes are summed inside it)...
    expect(screen.getAllByText('chatAssistant.thoughtFor')).toHaveLength(1)
    // ...and the two actions, separated only by the second reasoning, fall into one accordion.
    expect(screen.getAllByText('chatAssistant.actionsExecuted')).toHaveLength(1)
  })
})

// ── Degradation ─────────────────────────────────────────────────────────────

describe('ChatAssistantMessage — part with an empty src', () => {
  it('audio and video degrade to a card with the title, without crashing', () => {
    renderMessage([audioPart(''), videoPart('')])

    expect(screen.getByTestId('audio-part-unavailable')).toBeTruthy()
    expect(screen.getByTestId('video-part-unavailable')).toBeTruthy()
    expect(screen.getByText('parts.audio.unavailable')).toBeTruthy()
    expect(screen.getByText('parts.video.unavailable')).toBeTruthy()
  })

  it('artifact and document degrade to the preview-unavailable card', () => {
    renderMessage([artifactPart(''), documentPart('')])

    // No WebView mounted — there is no URL to request.
    expect(screen.queryByTestId('piece-view')).toBeNull()
    expect(screen.getByText('parts.artifact.empty')).toBeTruthy()
    expect(screen.getByText('parts.document.empty')).toBeTruthy()
    // The title stays visible: the assistant text may talk about it.
    expect(screen.getByText('Dashboard')).toBeTruthy()
    expect(screen.getByText('Quarterly report')).toBeTruthy()
  })
})

// ── PieceView on its own ────────────────────────────────────────────────────

describe('PieceView', () => {
  it('shows the poster while loading and hides it when the page is ready', () => {
    const poster = 'http://192.168.0.10:3848/api/file/artifact/art_abc.png/tok-artifact'
    render(<PieceView src={ARTIFACT_SRC} title="Piece" poster={poster} />)

    expect(screen.getByTestId('image').getAttribute('data-source')).toBe(poster)

    act(() => {
      webviews.props.at(-1)?.onLoadEnd()
    })

    expect(screen.queryByTestId('image')).toBeNull()
  })

  it('does not let the fullscreen be born open', () => {
    render(<PieceView src={ARTIFACT_SRC} title="Piece" />)
    expect(screen.queryByTestId('piece-view-fullscreen')).toBeNull()
  })
})
