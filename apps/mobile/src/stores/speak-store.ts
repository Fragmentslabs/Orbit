/**
 * Leitura em voz alta de uma resposta: pede o WAV ao desktop e toca.
 *
 * POR QUE UMA STORE, e não um hook por mensagem: o celular não sintetiza nada —
 * a fala atravessa como ARQUIVO (`POST /api/voice/speak` → WAV com token no
 * caminho) e é tocada pelo `expo-audio`. Um player por bolha significaria um
 * player nativo por mensagem da conversa; aqui é UM, criado no primeiro toque e
 * reaproveitado com `replace`. O estado também fica num lugar só, então "só uma
 * fala por vez" sai de graça.
 *
 * O texto não é montado aqui: chega pronto de `speakableText` (@orbit/shared),
 * a mesma regra que o desktop usa — senão o mesmo turno sairia diferente no
 * computador e no telefone.
 */
import { create } from 'zustand'
import { createAudioPlayer, type AudioPlayer } from 'expo-audio'
import type { ChatMessage } from '@orbit/shared'
import { speakableText } from '@orbit/shared'
import { claimAudioFocus, releaseAudioFocus } from '~/lib/audio-focus'
import { errorCodeFromHttpError } from '~/lib/http-error'
import i18n from '~/i18n'
import { useConnectionStore } from './connection-store'

/** Quanto o erro fica na tela antes de sumir sozinho (o mesmo do desktop). */
const ERROR_VISIBLE_MS = 6000

export type SpeakState = 'idle' | 'generating' | 'playing'

interface SpeakStore {
  state: SpeakState
  /** Mensagem cuja fala está sendo gerada ou tocando. */
  messageId: string | null
  /** Motivo da última falha (motor sem modelo, offline), já legível. */
  error: string | null
  /** Mensagem cuja fala falhou — o aviso só aparece naquela barra de ações. */
  errorMessageId: string | null
  /** Fala a resposta; segundo toque na mesma mensagem interrompe. */
  toggle: (message: ChatMessage) => void
  /** Silencia agora e invalida o pedido que estiver em voo. */
  stop: () => void
  dismissError: () => void
}

let player: AudioPlayer | null = null
/**
 * Número do último pedido. Uma resposta HTTP que chega depois de um toque novo
 * (ou de um stop) não pode roubar a fala — compara e desiste.
 */
let pedido = 0
let errorTimer: ReturnType<typeof setTimeout> | null = null

function clearErrorTimer(): void {
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = null
}

/** Player único do app, criado no primeiro toque. */
function ensurePlayer(): AudioPlayer {
  if (player) return player
  const criado = createAudioPlayer(null)
  // Fim do áudio → volta ao repouso. Sem isto o botão continuaria em "parar"
  // depois que a fala terminou.
  criado.addListener('playbackStatusUpdate', (status) => {
    if (!status.didJustFinish) return
    if (useSpeakStore.getState().state !== 'playing') return
    useSpeakStore.setState({ state: 'idle', messageId: null })
  })
  player = criado
  return criado
}

export const useSpeakStore = create<SpeakStore>((set, get) => ({
  state: 'idle',
  messageId: null,
  error: null,
  errorMessageId: null,

  toggle: (message) => {
    const texto = speakableText(message)
    if (!texto) return
    const atual = get()
    // Mesmo botão de novo: parar. Qualquer outra mensagem assume a fala.
    if (atual.messageId === message.id && atual.state !== 'idle') {
      get().stop()
      return
    }
    void run(message.id, texto)
  },

  stop: () => {
    // Invalida o pedido em voo: se a síntese ainda estiver rodando, a resposta
    // que chegar depois não toca.
    pedido++
    if (player) {
      try {
        player.pause()
      } catch {
        // Já liberado — nada a pausar.
      }
      releaseAudioFocus(player)
    }
    set({ state: 'idle', messageId: null })
  },

  dismissError: () => {
    clearErrorTimer()
    set({ error: null, errorMessageId: null })
  },
}))

/**
 * Código do desktop → chave i18n.
 *
 * O desktop manda código, não frase (`VoiceSpeakErrorCode` em @orbit/shared):
 * a frase é escrita aqui, onde se sabe em que idioma a pessoa está lendo. Um
 * código fora deste mapa — um 400 de validação, que só acontece se o app montar
 * o corpo errado — cai no aviso genérico, porque não há o que a pessoa fazer.
 */
const SPEAK_ERROR_KEY: Record<string, string> = {
  tts_disabled: 'voice.tts.errorDisabled',
  voice_unavailable: 'voice.tts.errorUnavailable',
}

function speakErrorText(error?: string): string {
  const codigo = errorCodeFromHttpError(error)
  const chave = codigo ? SPEAK_ERROR_KEY[codigo] : undefined
  return chave ? i18n.t(chave) : i18n.t('voice.tts.failed')
}

/** Falha: guarda o motivo, prende-o à mensagem que falhou e agenda a saída. */
function fail(messageId: string, motivo: string): void {
  useSpeakStore.setState({ state: 'idle', messageId: null, error: motivo, errorMessageId: messageId })
  clearErrorTimer()
  errorTimer = setTimeout(() => {
    errorTimer = null
    useSpeakStore.setState({ error: null, errorMessageId: null })
  }, ERROR_VISIBLE_MS)
}

async function run(messageId: string, texto: string): Promise<void> {
  const meu = ++pedido
  clearErrorTimer()
  useSpeakStore.setState({ state: 'generating', messageId, error: null, errorMessageId: null })

  const http = useConnectionStore.getState().http
  if (!http) {
    fail(messageId, i18n.t('voice.tts.offline'))
    return
  }

  const res = await http.speak(texto)
  // Toque novo ou stop no meio do caminho: este pedido morreu.
  if (meu !== pedido) return

  if (!res.ok || !res.data?.url) {
    fail(messageId, speakErrorText(res.error))
    return
  }

  const p = ensurePlayer()
  claimAudioFocus(p, () => {
    // Outro áudio assumiu a saída: esta fala acabou, e o botão precisa saber.
    if (useSpeakStore.getState().messageId === messageId) {
      useSpeakStore.setState({ state: 'idle', messageId: null })
    }
  })
  p.replace({ uri: res.data.url })
  p.play()
  useSpeakStore.setState({ state: 'playing', messageId })
}
