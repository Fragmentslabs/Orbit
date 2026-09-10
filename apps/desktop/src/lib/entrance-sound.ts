import { sound } from "./ipc"

/**
 * Som de entrada da persona, tocado no renderer com WebAudio.
 *
 * Antes o áudio era disparado pelo main process no did-finish-load, enquanto a
 * persona acordava num timer de 650ms após a montagem do React. A distância
 * entre as duas âncoras era o tempo de carregamento do renderer — desprezível
 * em produção (bundle único), mas de centenas de ms a segundos em dev (o Vite
 * transforma módulos sob demanda). Na prática o som começava visivelmente antes
 * de a persona acordar, principalmente rodando em dev.
 *
 * Aqui os bytes do WAV vêm do main via IPC (uma leitura única, sem timing) e o
 * áudio é decodificado durante o carregamento — a janela nasce escondida, então
 * não há o que tocar ainda. No instante do despertar a reprodução é agendada no
 * mesmo callback que dispara a transição da persona: áudio e persona começam
 * juntos, por construção, em dev e em produção. A decodificação no renderer não
 * depende de player do SO nem de fetch de asset (o fetch de file:// é bloqueado
 * no app empacotado, que carrega via loadFile).
 */

let audioContext: AudioContext | null = null
let entranceBuffer: AudioBuffer | null = null

/** Cria o contexto e decodifica o WAV. Falhas silenciam a entrada. */
export async function prepareEntranceSound(): Promise<void> {
  try {
    audioContext ??= new AudioContext()
    if (entranceBuffer) return
    const bytes = await sound.entranceData()
    if (!bytes) return
    entranceBuffer = await audioContext.decodeAudioData(bytes.buffer as ArrayBuffer)
  } catch (erro) {
    entranceBuffer = null
    console.warn("[som] falha ao preparar o som de entrada", erro)
  }
}

/** Toca o som de entrada agora, no relógio do AudioContext. */
export function playEntranceSound(): void {
  try {
    if (!audioContext || !entranceBuffer) return // sem buffer = entrada silenciosa
    void audioContext.resume()
    const fonte = audioContext.createBufferSource()
    fonte.buffer = entranceBuffer
    fonte.connect(audioContext.destination)
    fonte.start()
  } catch {
    // o som nunca pode derrubar a abertura do app
  }
}