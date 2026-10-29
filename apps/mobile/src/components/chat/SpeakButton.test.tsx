import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatMessage, MessagePart } from '@orbit/shared'
// Os `vi.mock` abaixo são içados pelo vitest acima destes imports — a ordem
// aqui é só de leitura (o `import/first` reclama de import depois de mock).
import { SpeakButton } from './SpeakButton'
import { MessageActions } from './MessageActions'
import { useSpeakStore } from '~/stores/speak-store'
import { useConnectionStore } from '~/stores/connection-store'

/**
 * OUVIR: o botão que pede a fala ao desktop e toca o WAV.
 *
 * O que se prova aqui é o contrato com o desktop e as três regras que a pessoa
 * percebe: só lê RESPOSTA (nunca o que ela mesma escreveu), só lê o texto final
 * (sem o JSON do orbit-ui), e um segundo toque cala em vez de abrir uma segunda
 * fala. A falha tem de dizer POR QUE — "baixe o modelo" —, não deixar um botão
 * morto.
 *
 * O motor de voz e o player nativo não existem no jsdom: `expo-audio` é o
 * módulo substituído aqui, e a rede é o `http` falso do connection-store.
 */

// O código do Expo lê `__DEV__`, que existe no bundle do RN e não no Node.
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

// A store fala com o i18n fora de componente: aqui a chave volta como texto.
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
    // Ícones da barra de ações, onde o aviso de falha aparece.
    CheckCircle: Icon,
    Copy: Icon,
    Reply: Icon,
    RotateCcw: Icon,
  }
})

const URL_FALA = 'http://192.168.0.10:3848/api/file/audio/aud_speech.wav/tok-audio'

const fakeHttp = vi.hoisted(() => ({ speak: vi.fn() }))

const texto = (text: string): MessagePart => ({ id: 't1', type: 'text', text }) as MessagePart

const ferramenta = (): MessagePart =>
  ({ id: 'tool1', type: 'tool', toolName: 'read', toolCallId: 'c1', state: 'output-available' }) as unknown as MessagePart

function mensagem(role: 'assistant' | 'user', parts: MessagePart[]): ChatMessage {
  return { id: 'msg-1', role, parts, createdAt: 0, completedAt: 0 } as ChatMessage
}

function falaPronta() {
  fakeHttp.speak.mockResolvedValue({
    ok: true,
    data: { id: 'aud_speech.wav', url: URL_FALA, durationMs: 1200, cached: false },
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

describe('quando o botão existe', () => {
  it('não aparece em mensagem do usuário — o que ela escreveu não se lê de volta', () => {
    render(<SpeakButton message={mensagem('user', [texto('bom dia')])} />)
    expect(screen.queryByTestId('speak-button')).toBeNull()
  })

  it('não aparece em turno só de ferramenta: não há prosa para ler', () => {
    render(<SpeakButton message={mensagem('assistant', [ferramenta()])} />)
    expect(screen.queryByTestId('speak-button')).toBeNull()
  })

  it('aparece na resposta com prosa', () => {
    render(<SpeakButton message={mensagem('assistant', [texto('pronto.')])} />)
    expect(screen.getByTestId('speak-button')).toBeTruthy()
  })
})

describe('o que é falado', () => {
  it('só a resposta final, sem a narração anterior à ferramenta', async () => {
    falaPronta()
    const parts = [texto('vou verificar'), ferramenta(), texto('pronto, três arquivos.')]
    render(<SpeakButton message={mensagem('assistant', parts)} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(fakeHttp.speak).toHaveBeenCalledTimes(1))
    expect(fakeHttp.speak.mock.calls[0][0]).toBe('pronto, três arquivos.')
    // A URL vem pronta do desktop (token no caminho): não se monta nada aqui.
    expect(audio.player.replace).toHaveBeenCalledWith({ uri: URL_FALA })
    expect(audio.player.play).toHaveBeenCalled()
  })

  it('o JSON do orbit-ui não vira fala', async () => {
    falaPronta()
    const parts = [texto('aqui está:\n```orbit-ui\n{"type":"stats","items":[]}\n```')]
    render(<SpeakButton message={mensagem('assistant', parts)} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(fakeHttp.speak).toHaveBeenCalledTimes(1))
    expect(fakeHttp.speak.mock.calls[0][0]).toBe('aqui está:')
  })
})

describe('controle', () => {
  it('segundo toque na mesma mensagem interrompe', async () => {
    falaPronta()
    render(<SpeakButton message={mensagem('assistant', [texto('pronto.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))
    await waitFor(() => expect(useSpeakStore.getState().state).toBe('playing'))

    fireEvent.click(screen.getByTestId('speak-button'))
    expect(audio.player.pause).toHaveBeenCalled()
    expect(useSpeakStore.getState().state).toBe('idle')
  })

  it('pedido que volta depois de um stop não toca', async () => {
    let liberar: (v: unknown) => void = () => {}
    fakeHttp.speak.mockReturnValue(new Promise((resolve) => { liberar = resolve }))
    render(<SpeakButton message={mensagem('assistant', [texto('pronto.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))
    expect(useSpeakStore.getState().state).toBe('generating')

    // A pessoa desiste antes da síntese terminar.
    fireEvent.click(screen.getByTestId('speak-button'))
    liberar({ ok: true, data: { id: 'aud_x.wav', url: URL_FALA, durationMs: 1, cached: false } })

    await waitFor(() => expect(useSpeakStore.getState().state).toBe('idle'))
    expect(audio.player.play).not.toHaveBeenCalled()
  })
})

describe('falha', () => {
  it('traduz o código do desktop — a frase de lá não chega à tela', async () => {
    fakeHttp.speak.mockResolvedValue({
      ok: false,
      error: '503: {"error":"voice_unavailable","detail":"os modelos do TTS ainda não foram baixados"}',
    })
    render(<SpeakButton message={mensagem('assistant', [texto('pronto.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(useSpeakStore.getState().error).toBe('voice.tts.errorUnavailable'))
    expect(audio.player.play).not.toHaveBeenCalled()
  })

  it('desligado nas preferências do desktop tem frase própria', async () => {
    fakeHttp.speak.mockResolvedValue({ ok: false, error: '503: {"error":"tts_disabled"}' })
    render(<SpeakButton message={mensagem('assistant', [texto('pronto.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(useSpeakStore.getState().error).toBe('voice.tts.errorDisabled'))
  })

  it('código fora do mapa cai no aviso genérico, não em JSON na tela', async () => {
    fakeHttp.speak.mockResolvedValue({ ok: false, error: '400: {"error":"invalid_speed"}' })
    render(<SpeakButton message={mensagem('assistant', [texto('pronto.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(useSpeakStore.getState().error).toBe('voice.tts.failed'))
  })

  it('sem conexão com o desktop, avisa em vez de falhar calado', async () => {
    useConnectionStore.setState({ http: null })
    render(<SpeakButton message={mensagem('assistant', [texto('pronto.')])} />)

    fireEvent.click(screen.getByTestId('speak-button'))

    await waitFor(() => expect(useSpeakStore.getState().error).toBe('voice.tts.offline'))
    expect(fakeHttp.speak).not.toHaveBeenCalled()
  })

  it('o aviso fica na barra da mensagem que falhou, não em todas', () => {
    useSpeakStore.setState({ error: 'sem motor de voz', errorMessageId: 'outra-msg' })
    render(<MessageActions message={mensagem('assistant', [texto('pronto.')])} />)
    expect(screen.queryByText('sem motor de voz')).toBeNull()

    cleanup()
    useSpeakStore.setState({ error: 'sem motor de voz', errorMessageId: 'msg-1' })
    render(<MessageActions message={mensagem('assistant', [texto('pronto.')])} />)
    expect(screen.getByText('sem motor de voz')).toBeTruthy()
  })
})
