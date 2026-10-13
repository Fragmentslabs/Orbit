/**
 * Ditado por voz (STT) no processo MAIN — a fachada pública.
 *
 * Dois motores, ambos locais e sem nuvem:
 *   - **parakeet**: sherpa-onnx (addon N-API, roda no Electron sem rebuild), CPU,
 *     VAD Silero fatiando o áudio para o texto ao vivo — o candidato de Windows e
 *     Linux (ver `parakeet.ts`);
 *   - **whisper**: whisper.cpp como PROCESSO AUXILIAR `whisper-server`, modelos
 *     ggml baixados sob demanda, decodificação greedy explícita (ver `whisper.ts`).
 *
 * O renderer manda áudio a 16 kHz mono PCM16; os dois motores trabalham a 16 kHz,
 * então no caminho comum NADA é reamostrado. `StreamResampler` só entra se a taxa
 * vier diferente — caso o motor venha a exigir outra taxa.
 *
 * `STT_MODELS` é também a fonte do catálogo do núcleo (`manifest.ts` junta esta
 * lista à do TTS), por isso cada entrada segue `VoiceModelInfo` à risca: `bytes`
 * é o tamanho exato do download e `url` aponta o arquivo direto.
 */

import { randomUUID } from 'node:crypto'
import type { VoiceEngineId, VoiceEngineStatus, VoiceModelInfo } from '@shared/voice'
import { getAppSettings } from '../app-settings'
import { getSttModel, STT_MODEL_DEFS } from './catalog'
import { ensureParakeetExtracted, fileComplete, isParakeetReady } from './models-store'
import { parakeetEngine } from './parakeet'
import { whisperAutoModelId, whisperEngine } from './whisper'
import { pcm16ToFloat32, samplesToMs, STT_SAMPLE_RATE, StreamResampler } from './audio'
import type { SttEngine, SttHandle, SttSegment } from './engine'

/**
 * Catálogo declarativo dos modelos de ditado: id, motor, rótulo, bytes, URL e
 * idiomas. Nada é baixado aqui — o download é sob demanda (`download.ts`) e o
 * estado de instalação sai em `sttEngineStatus()`.
 */
export const STT_MODELS: VoiceModelInfo[] = STT_MODEL_DEFS.map((m) => ({
  id: m.id,
  kind: 'stt',
  engine: m.engine,
  label: m.label,
  bytes: m.bytes,
  url: m.url,
  sha256: m.sha256,
  langs: m.langs,
  archive: m.archive,
}))

const ENGINES: Record<VoiceEngineId, SttEngine> = {
  parakeet: parakeetEngine,
  whisper: whisperEngine,
}

/**
 * O modelo está UTILIZÁVEL pelo motor agora — é a resposta que o `voice:status`
 * publica como `installed`. Para o Parakeet é o pacote EXTRAÍDO com o VAD
 * Silero presente; para o whisper é o arquivo completo (não há extração).
 */
export function sttModelInstalled(modelId: string): boolean {
  const def = getSttModel(modelId)
  if (!def) return false
  if (def.archive) return isParakeetReady()
  return fileComplete(def)
}

/**
 * Deixa um modelo já baixado pronto para uso (extrai o pacote quando for o
 * caso). Idempotente: um modelo pronto resolve na hora, sem tocar no arquivo.
 * O download do núcleo chama isto logo ao terminar; o motor também chama no
 * primeiro uso, então a extração nunca depende de um caminho só.
 */
export async function prepareSttModel(modelId: string): Promise<void> {
  const def = getSttModel(modelId)
  if (def?.archive) await ensureParakeetExtracted()
}

/**
 * Aquece um motor de ditado em SEGUNDO PLANO — a primeira sessão do usuário não
 * paga o carregamento do modelo (no Parakeet, centenas de MB no ONNX Runtime).
 *
 * Nunca rejeita: o erro, se houver, aparece no `status()` do motor. Idempotente,
 * então pode ser disparado sem cuidado — o botão de microfone chama sempre que
 * aparece e o fim de um download chama por conta própria.
 */
export async function warmSttModel(modelId?: string | null, engine?: string, threads?: number): Promise<void> {
  if (!sttPreloadEnabled()) return
  const def = modelId ? getSttModel(modelId) : null
  // Um id que não é de ditado (um modelo de fala, por exemplo) não aquece nada.
  if (modelId && !def) return
  const engineId = (def?.engine ?? engine) as VoiceEngineId | undefined
  const alvo = engineId ? ENGINES[engineId] : undefined
  await alvo?.warm?.(modelId ?? null, threads)
  agendarLiberacao()
}

/**
 * O pré-carregamento está ligado? Sem ele ninguém aquece por antecipação: o
 * primeiro ditado é que paga o carregamento (a troca é RAM por espera, e quem
 * decide é o usuário). Vem das configurações do main, não do payload.
 */
export function sttPreloadEnabled(): boolean {
  const settings = getAppSettings() as { voice?: { stt?: { preload?: unknown; enabled?: unknown } } } | null
  // Ditado desligado também não pré-carrega: nenhum chamador (o botão, o fim
  // de um download) deve prender o modelo na memória de quem desligou a voz.
  return settings?.voice?.stt?.preload !== false && settings?.voice?.stt?.enabled !== false
}

/** Quanto tempo sem ditado antes de soltar o modelo que o `warm` carregou. */
const IDLE_RELEASE_MS = 5 * 60_000

let idleTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Solta AGORA o que os motores carregaram, sem esperar o ciclo ocioso. É o que a
 * troca da preferência de pré-carregamento dispara: desligar o preload devolve a
 * RAM na hora, em vez de daqui a cinco minutos.
 *
 * Com sessão aberta o modelo está em uso: não o solta no meio dela, adia.
 */
export function releaseSttModels(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (sessions.size > 0) {
    agendarLiberacao()
    return
  }
  for (const engine of Object.values(ENGINES)) {
    try {
      engine.release?.()
    } catch {
      // soltar é melhor-esforço: nunca derruba o main
    }
  }
}

/**
 * Marca atividade do ditado e (re)agenda a liberação: passado o tempo ocioso sem
 * sessão aberta, o que foi carregado é solto — no Parakeet são centenas de MB
 * residentes. Uma sessão em curso adia a liberação.
 */
function agendarLiberacao(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    releaseSttModels()
  }, IDLE_RELEASE_MS)
  idleTimer.unref?.()
}

/** Estado de cada motor para a UI montar os seletores e o botão de baixar. */
export async function sttEngineStatus(): Promise<VoiceEngineStatus[]> {
  const statuses = await Promise.all([parakeetEngine.status(), whisperEngine.status()])
  return statuses.map((s) => ({
    engine: s.engine,
    installed: s.installed,
    available: s.available,
    // "Baixado" é o arquivo no disco (para o Parakeet, o próprio .tar.bz2): o
    // motor pode estar sem extrair o pacote — e a UI precisa saber disso para
    // não chamar de "não baixado" o que já está lá.
    downloaded: STT_MODEL_DEFS.some((m) => m.engine === s.engine && fileComplete(m)),
    reason: s.reason,
    autoModelId: s.engine === 'whisper' ? whisperAutoModelId() : ENGINES[s.engine].defaultModelId,
  }))
}

/** Sessão de ditado aberta (o motor e o áudio vivem no main). */
export interface SttSession {
  id: string
}

interface ActiveSession {
  id: string
  engineId: VoiceEngineId
  handle: SttHandle
  /** Reamostrador só quando a taxa de entrada difere de 16 kHz. */
  resampler: StreamResampler | null
  inputSamples: number
  inputRate: number
  startedAt: number
}

const sessions = new Map<string, ActiveSession>()

/** Forma da entrada do start (a API pública a declara inline). */
interface StartSttInput {
  engine: VoiceEngineId
  modelId?: string | null
  language?: string
  /** Taxa do áudio que o renderer vai mandar (16 kHz na captura padrão). */
  sampleRate: number
  threads?: number
  /** Pedir texto ao vivo enquanto a fala acontece. */
  live: boolean
  /** Pedir os trechos com tempo (transcrição de arquivo); 'words' = por palavra. */
  timestamps?: boolean | 'words'
}

/**
 * Abre uma sessão de ditado. Só resolve quando o modelo está carregado e pronto
 * (o Parakeet extrai o pacote e aquece o ONNX Runtime; o whisper espera o
 * `/health` do servidor): erro de preparo sai aqui, não no meio da fala.
 */
export async function startSttSession(
  input: StartSttInput,
  onPartial: (text: string) => void,
): Promise<SttSession> {
  const engine = ENGINES[input.engine]
  if (!engine) throw new Error(`motor de ditado desconhecido: ${String(input.engine)}`)

  const rate = input.sampleRate > 0 ? input.sampleRate : STT_SAMPLE_RATE
  const partial = (text: string): void => {
    try {
      onPartial(text)
    } catch {
      // o callback é do chamador; um erro nele não pode derrubar o motor
    }
  }

  const handle = await engine.start(
    {
      modelId: input.modelId ?? null,
      language: input.language || 'pt',
      threads: input.threads,
      live: Boolean(input.live),
      timestamps: input.timestamps || false,
    },
    partial,
  )

  const id = randomUUID()
  sessions.set(id, {
    id,
    engineId: engine.id,
    handle,
    resampler: rate === STT_SAMPLE_RATE ? null : new StreamResampler(rate, STT_SAMPLE_RATE),
    inputSamples: 0,
    inputRate: rate,
    startedAt: Date.now(),
  })
  // Sessão aberta é atividade: o modelo não pode ser solto enquanto ela dura.
  agendarLiberacao()
  return { id }
}

/**
 * Áudio da captura: PCM16LE mono na taxa declarada no start.
 *
 * É `void` de propósito — o caminho do áudio é quente e não pode esperar; uma
 * sessão já encerrada simplesmente descarta o pedaço.
 */
export function pushSttAudio(id: string, pcm: Buffer): void {
  const s = sessions.get(id)
  if (!s) return
  const floats = pcm16ToFloat32(pcm)
  s.inputSamples += floats.length
  s.handle.pushAudio(s.resampler ? s.resampler.push(floats) : floats)
}

/** Fecha a sessão e devolve o texto final, a duração do áudio e o tempo gasto. */
export async function stopSttSession(
  id: string,
): Promise<{ text: string; audioMs: number; ms: number; segments?: SttSegment[] }> {
  const s = sessions.get(id)
  if (!s) throw new Error(`sessão de ditado inexistente: ${id}`)
  sessions.delete(id)
  const t0 = Date.now()
  const result = await s.handle.stop()
  // Fim de sessão é atividade: a contagem da liberação ociosa recomeça daqui.
  agendarLiberacao()
  return {
    text: result.text,
    audioMs: samplesToMs(s.inputSamples, s.inputRate),
    ms: Date.now() - t0,
    segments: result.segments,
  }
}

/** Aborta a sessão sem transcrever (o usuário apertou Esc, a janela fechou…). */
export async function cancelSttSession(id: string): Promise<void> {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  await s.handle.cancel()
  agendarLiberacao()
}
