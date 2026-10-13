/**
 * Contrato interno dos motores de ditado.
 *
 * `stt.ts` é a fachada pública (a API pedida); cada motor implementa `SttEngine`
 * e cuida da própria peculiaridade: o Parakeet carrega um modelo ONNX na CPU e
 * fatia com VAD; o whisper fala com um `whisper-server` (processo auxiliar).
 * A fachada não sabe nada disso — só repassa áudio de 16 kHz e recebe texto.
 *
 * O único tipo que vem de fora é `VoiceEngineId` (de `@shared/voice`, type-only,
 * então não há ciclo de runtime com o manifesto do núcleo).
 */

import type { VoiceEngineId } from '@shared/voice'

/** Entrada já normalizada da sessão: áudio sempre a 16 kHz mono. */
export interface SttStartInput {
  /** Modelo escolhido; o motor decide o padrão quando vier nulo. */
  modelId: string | null
  /** Código do idioma ("pt", "en"…) ou "auto" para o motor detectar. */
  language: string
  /** Nº de threads de CPU (motores que aceitam); opcional. */
  threads?: number
  /** Pedir texto ao vivo enquanto a fala acontece. */
  live: boolean
  /** Pedir os trechos com tempo (transcrição de arquivo com timestamps). */
  timestamps?: boolean
}

/** Trecho transcrito com a posição no áudio da sessão. */
export interface SttSegment {
  startMs: number
  endMs: number
  text: string
}

/** Sessão de um motor, já com o modelo carregado/pronto. */
export interface SttHandle {
  pushAudio(samples: Float32Array): void
  /** `segments` vem quando o motor sabe dar tempos (Parakeet: trechos do VAD;
   *  whisper: segmentos do servidor, só com `timestamps` pedido). */
  stop(): Promise<{ text: string; audioMs: number; segments?: SttSegment[] }>
  cancel(): Promise<void>
}

/** Estado de um motor (o que virou `VoiceEngineStatus` na fachada). */
export interface SttEngineStatus {
  engine: VoiceEngineId
  /** O motor consegue rodar NESTA máquina (módulo/binário presente e modelo no disco). */
  available: boolean
  /** Está tudo pronto para transcrever já (modelo carregável sem preparo extra). */
  installed: boolean
  /** Explicação quando não dá para rodar (o que falta, onde pôr). */
  reason?: string
  /** Dados de diagnóstico para a tela de configurações. */
  detail?: Record<string, unknown>
}

export interface SttEngine {
  readonly id: VoiceEngineId
  readonly label: string
  /** Modelo usado quando `modelId` vem nulo. */
  readonly defaultModelId: string
  status(): Promise<SttEngineStatus>
  /**
   * Carrega o modelo ANTES do primeiro uso, em SEGUNDO PLANO (opcional). No
   * Parakeet isso são centenas de MB no ONNX Runtime; sem um aquecimento, a
   * primeira sessão do usuário paga o carregamento — e o botão fica vermelho
   * esperando por ele. Idempotente e silencioso: erro de carga não vira exceção
   * aqui, aparece no `status()`.
   */
  warm?(modelId: string | null, threads?: number): Promise<void>
  /**
   * Solta o que o `warm` carregou (opcional), quando o ditado fica ocioso: o
   * modelo não deve ocupar RAM a sessão inteira. O próximo `warm`/`start`
   * carrega de novo.
   */
  release?(): void
  start(input: SttStartInput, onPartial: (text: string) => void): Promise<SttHandle>
}
