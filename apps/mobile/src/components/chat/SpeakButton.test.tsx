import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatMessage, MessagePart } from '@orbit/shared'
// The `vi.mock` below are hoisted by vitest above these imports — the order
// here is only for reading (the `import/first` rule complains about an import after a mock).
import { SpeakButton } from './SpeakButton'
import { MessageActions } from './MessageActions'
import { useSpeakStore } from '~/stores/speak-store'
import { useConnectionStore } from '~/stores/connection-store'

/**
 * LISTEN: the button that asks the desktop for the speech and plays the WAV.
 *
 * What is proven here is the contract with the desktop and the three rules the person
 * perceives: it only reads an ANSWER (never what they wrote themselves), it only reads the final text
 * (without the orbit-ui JSON), and a second tap silences it instead of opening a second
 * speech. The failure has to say WHY — "download the model" —, not leave a dead
 * button.
 *
 * The voice engine and the native player do not exist in jsdom: `expo-audio` is the
 * module replaced here, and the network is the fake `http` of the connection-store.
 */

// The Expo code reads `__DEV__`, which exists in the RN bundle and not in Node.
vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).__DEV__ = false
})

const audio = vi.hoisted(() => ({
  player: {
    play: vi.fn(),
    pause: vi.fn(),
    replace: vi.fn(),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}))

vi.mock('expo-audio', () => ({ createAudioPlayer: () => audio.player }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }),
}))

// The store talks to i18n outside a component: here the key comes back as text.
vi.mock('~/i18n', () => ({ default: { t: (key: string) => key } }))

vi.mock('~/stores/theme-store', () => ({
  useThemeStore: (selector: (state: { resolved: string }) => unknown) => selector({ resolved: 'dark' }),
}))

vi.mock('lucide-react-native', async () => {
  const React = await import('react')
  const Icon = () => React.createElement('i')
  return {
    Square: Icon,
    Volume2: Icon,
    // Icons of the actions bar, where the failure notice shows up.
    CheckCircle: Icon,
    Copy: Icon,
    Reply: Icon,
    RotateCcw: Icon,
  }
})

const SPEECH_URL = 'http://192.168.0.10:3848/api/file/audio/aud_speech.wav/tok-audio'

const fakeHttp = vi.hoisted(() => ({ speak: vi.fn() }))

const textPart = (text: string): MessagePart => ({ id: 't1', type: 'text', text }) as MessagePart

const toolPart = (): MessagePart =>
  ({ id: 'tool1', type: 'tool', toolName: 'read', toolCallId: 'c1', state: 'output-available' }) as unknown as MessagePart

function message(role: 'assistant' | 'user', parts: MessagePart[]): ChatMessage {
  return { id: 'msg-1', role, parts, createdAt: 0, completedAt: 0 } as ChatMessage
}

function speechReady() {
  fakeHttp.speak.mockResolvedValue({
    ok: true,
    data: { id: 'aud_speech.wav', url: SPEECH_URL, durationMs: 1200, cached: false },
  })
}

beforeEach(() => {
  useSpeakStore.setState({ state: 'idle', messageId: null, error: null, errorMessageId: null })
  useConnectionStore.setState({ http: fakeHttp as never })
  fakeHttp.speak.mockReset()
  audio.player.play.mockClear()
  audio.player.pause.mockClear()
  audio.player.replace.mockClear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('when the button exists', () => {
  it('does not show up on a user message — what they wrote is not read back', () => {
    render(<SpeakButton message={message('user', [textPart('good morning')])} />)
    expect(screen.queryByTestId('speak-button')).toBeNull()
  })

  it('does not show up on a tool-only turn: there is no prose to read', () => {
    render(<SpeakButton message={message('assistant', [toolPart()])} />)
    expect(screen.queryByTestId('speak-button')).toBeNull()
  })

  it('shows up on an answer with prose', () => {
    render(<SpeakButton message={message('assistant', [textPart('done.')])} />)
    expect(screen.getByTestId('speak-button')).toBeTruthy()
  })
})

describe('what gets spoken', () => {
  it('only the final answer, without the narration before the tool', async () => {
    speechReady()
    const parts = [textPart('let me check'), toolPart(), textPart('done, three files.')]
    render(<SpeakButton message={message('assistant', parts)} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(fakeHttp.speak).toHaveBeenCalledTimes(1))
    expect(fakeHttp.speak.mock.calls[0][0]).toBe('done, three files.')
    // The URL comes ready from the desktop (token in the path): nothing is assembled here.
    expect(audio.player.replace).toHaveBeenCalledWith({ uri: SPEECH_URL })
    expect(audio.player.play).toHaveBeenCalled()
  })

  it('the orbit-ui JSON does not become speech', async () => {
    speechReady()
    const parts = [textPart('here it is:\n```orbit-ui\n{"type":"stats","items":[]}\n```')]
    render(<SpeakButton message={message('assistant', parts)} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(fakeHttp.speak).toHaveBeenCalledTimes(1))
    expect(fakeHttp.speak.mock.calls[0][0]).toBe('here it is:')
  })
})

describe('control', () => {
  it('a second tap on the same message stops it', async () => {
    speechReady()
    render(<SpeakButton message={message('assistant', [textPart('done.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))
    await waitFor(() => expect(useSpeakStore.getState().state).toBe('playing'))

    fireEvent.click(screen.getByTestId('speak-button'))
    expect(audio.player.pause).toHaveBeenCalled()
    expect(useSpeakStore.getState().state).toBe('idle')
  })

  it('a request that comes back after a stop does not play', async () => {
    let release: (v: unknown) => void = () => {}
    fakeHttp.speak.mockReturnValue(new Promise((resolve) => { release = resolve }))
    render(<SpeakButton message={message('assistant', [textPart('done.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))
    expect(useSpeakStore.getState().state).toBe('generating')

    // The person gives up before the synthesis finishes.
    fireEvent.click(screen.getByTestId('speak-button'))
    release({ ok: true, data: { id: 'aud_x.wav', url: SPEECH_URL, durationMs: 1, cached: false } })

    await waitFor(() => expect(useSpeakStore.getState().state).toBe('idle'))
    expect(audio.player.play).not.toHaveBeenCalled()
  })
})

describe('failure', () => {
  it('translates the desktop code — the phrase from there never reaches the screen', async () => {
    fakeHttp.speak.mockResolvedValue({
      ok: false,
      error: '503: {"error":"voice_unavailable","detail":"the TTS models were not downloaded yet"}',
    })
    render(<SpeakButton message={message('assistant', [textPart('done.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(useSpeakStore.getState().error).toBe('voice.tts.errorUnavailable'))
    expect(audio.player.play).not.toHaveBeenCalled()
  })

  it('turned off in the desktop preferences has its own phrase', async () => {
    fakeHttp.speak.mockResolvedValue({ ok: false, error: '503: {"error":"tts_disabled"}' })
    render(<SpeakButton message={message('assistant', [textPart('done.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(useSpeakStore.getState().error).toBe('voice.tts.errorDisabled'))
  })

  it('a code outside the map falls back to the generic notice, not to JSON on screen', async () => {
    fakeHttp.speak.mockResolvedValue({ ok: false, error: '400: {"error":"invalid_speed"}' })
    render(<SpeakButton message={message('assistant', [textPart('done.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(useSpeakStore.getState().error).toBe('voice.tts.failed'))
  })

  it('without a connection to the desktop, it warns instead of failing silently', async () => {
    useConnectionStore.setState({ http: null })
    render(<SpeakButton message={message('assistant', [textPart('done.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(useSpeakStore.getState().error).toBe('voice.tts.offline'))
    expect(fakeHttp.speak).not.toHaveBeenCalled()
  })

  it('the notice stays on the bar of the message that failed, not on all of them', () => {
    useSpeakStore.setState({ error: 'no voice engine', errorMessageId: 'other-msg' })
    render(<MessageActions message={message('assistant', [textPart('done.')])} />)
    expect(screen.queryByText('no voice engine')).toBeNull()

    cleanup()
    useSpeakStore.setState({ error: 'no voice engine', errorMessageId: 'msg-1' })
    render(<MessageActions message={message('assistant', [textPart('done.')])} />)
    expect(screen.getByText('no voice engine')).toBeTruthy()
  })
})
