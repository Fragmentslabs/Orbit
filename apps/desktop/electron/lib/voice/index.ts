import { BrowserWindow, ipcMain } from "electron"
import { randomUUID } from "node:crypto"
import type {
  VoiceDownloadProgress,
  VoiceEngineId,
  VoiceHardwareInfo,
  VoiceModelInfo,
  VoiceTtsEngine,
} from "@shared/voice"
import type { VoiceStatusResponse } from "@shared/companion"
import { getAppSettings } from "../app-settings"
import { VOICE_MODELS, TTS_MODEL_ID, modelInfo } from "./manifest"
import { cancelDownload, isModelDownloaded, removeModel, startDownload } from "./download"
import { onParakeetExtractPhaseChange } from "./models-store"
import { speakWithModel } from "./model-tts"
import { downloadedModelIds, voiceStatusSnapshot } from "./status"
import { detectHardware } from "./hardware"
import { shutdownTts, speak, ttsStatus } from "./tts"
// STT é o outro worker: aqui só se consome o que ele exporta (ver o rodapé).
import {
  STT_MODELS,
  cancelSttSession,
  prepareSttModel,
  pushSttAudio,
  releaseSttModels,
  startSttSession,
  sttEngineStatus,
  stopSttSession,
  sttPreloadEnabled,
  warmSttModel,
} from "./stt"

/**
 * Fachada do núcleo de voz: `registerVoiceIpc()` liga os canais e o resto do
 * arquivo é o que outros módulos do main usam por import direto.
 *
 * Contrato dos canais (consumido por três telas do renderer — NÃO renomear):
 *   invoke "voice:hardware"          -> VoiceHardwareInfo
 *   invoke "voice:models"            -> VoiceModelInfo[]
 *   invoke "voice:status"            -> VoiceStatusSnapshot
 *   invoke "voice:download"          { modelId }  -> { started: boolean }
 *   invoke "voice:download-cancel"   { modelId }  -> void
 *   invoke "voice:remove-model"      { modelId }  -> void
 *   evento "voice:download-progress" -> VoiceDownloadProgress
 *   evento "voice:status-changed"    -> VoiceStatusSnapshot (a cada mudança)
 *   invoke "voice:tts:start"         { text, voice?, lang?, speed?, engine? } -> { id }
 *                                     (`engine`: prioridade de áudio "model" | "local";
 *                                      sem ele, vale a das configurações)
 *   evento "voice:tts:chunk"         -> { id, pcm (base64 PCM16), sr, i, n }
 *   evento "voice:tts:done"          -> { id, error? }
 *   invoke "voice:tts:cancel"        { id } -> void
 *
 * Os modelos de STT ficam no catálogo (`voice:models`) e no `voice:status`
 * (motores disponíveis); as sessões de ditado em si são do worker de STT, que
 * registra os canais dele em ./stt.
 */

/** Eventos de voz vão para TODAS as janelas (o app pode ter mais de uma). */
function emitir(canal: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(canal, payload)
  }
}

async function hardware(): Promise<VoiceHardwareInfo> {
  return detectHardware({ downloadedIds: await downloadedModelIds() })
}

/**
 * Publica o retrato atual em `voice:status-changed`. O renderer escuta esse
 * canal para revalidar o botão de fala e os selos — sem isto, baixar o modelo
 * e voltar ao chat deixava o botão desativado (nada avisava que mudou).
 */
async function emitStatusChanged(): Promise<void> {
  emitir("voice:status-changed", await voiceStatusSnapshot())
}

/**
 * Depois do fim de um download: avisa o novo estado e, quando o modelo é um
 * PACOTE (o `.tar.bz2` do Parakeet), extrai na hora — "baixado" nunca fica se
 * apresentando como "pronto". A extração também pode começar no primeiro uso
 * (dentro do motor); os dois caminhos passam pelo mesmo aviso de fase (ver
 * `onParakeetExtractPhaseChange` em ./models-store).
 */
async function aposDownload(modelId: string, progress: VoiceDownloadProgress): Promise<void> {
  await emitStatusChanged()
  if (!progress.done || progress.error) return
  const model = modelInfo(modelId)
  if (!model) return
  // Cancelamento chega como `done` sem erro: só prepara o que está completo.
  if (!(await isModelDownloaded(modelId))) return
  if (model.archive) {
    await prepareSttModel(modelId).catch(() => {
      // a falha já ficou registrada na fase da extração (aparece no próximo status)
    })
    await emitStatusChanged()
  }
  // Aquece em segundo plano, sem `await`: o primeiro ditado não deve pagar o
  // carregamento do modelo (no Parakeet, centenas de MB no ONNX Runtime). Não
  // faz nada quando o id não é de ditado — ver `warmSttModel`.
  void warmSttModel(modelId)
}

/** Falas em andamento, por id — é como o `voice:tts:cancel` acha o pedido. */
const falas = new Map<string, AbortController>()

/** Pedido de fala vindo do renderer (`voice:tts:start`). */
interface FalaPedido {
  text?: string
  voice?: string
  lang?: string
  speed?: number
  /** Prioridade de áudio; sem ela, vale a das configurações (`voice.tts.engine`). */
  engine?: VoiceTtsEngine
}

/** Um pedaço do contrato `voice:tts:chunk` (PCM16 base64). */
interface FalaChunk {
  pcm: Buffer
  sr: number
  i: number
  n: number
}

/**
 * Roda UMA fala pelo motor escolhido pela prioridade de áudio.
 *
 * `model` tenta a rota do provedor e, quando ela não existe ou falha ANTES de
 * entregar qualquer pedaço, cai no motor local — a preferência não deixa a
 * leitura muda. Com áudio já entregue, trocar de motor no meio emendaria duas
 * vozes diferentes, então a falha sobe como erro.
 */
async function rodarFala(id: string, texto: string, payload: FalaPedido, signal: AbortSignal): Promise<void> {
  const pedido = { voice: payload?.voice, lang: payload?.lang, speed: payload?.speed }
  const emitirChunk = (chunk: FalaChunk) =>
    emitir("voice:tts:chunk", { id, pcm: chunk.pcm.toString("base64"), sr: chunk.sr, i: chunk.i, n: chunk.n })

  const engine: VoiceTtsEngine = payload?.engine ?? getAppSettings().voice.tts.engine
  if (engine === "model") {
    let entregou = false
    try {
      await speakWithModel(
        texto,
        pedido,
        (chunk) => {
          entregou = true
          emitirChunk(chunk)
        },
        signal,
      )
      return
    } catch (err) {
      if (entregou || signal.aborted) throw err
      console.warn("[voice] rota pelo modelo indisponível, usando o motor local:", err)
    }
  }
  // `local` — o motor do Supertonic, offline.
  await speak(texto, pedido, emitirChunk, signal)
}

/**
 * Registra os canais de voz. Chamado uma vez, junto dos outros registros do
 * main (ver main.ts) — nada aqui pode ser registrado duas vezes.
 */
export function registerVoiceIpc(): void {
  // A extração do pacote começa por dois caminhos (logo após o download ou no
  // primeiro uso, dentro do motor). Um só aviso cobre os dois: cada mudança de
  // fase publica o estado novo em `voice:status-changed`.
  onParakeetExtractPhaseChange(() => {
    void emitStatusChanged()
  })

  ipcMain.handle("voice:hardware", () => hardware())

  ipcMain.handle("voice:models", (): VoiceModelInfo[] => VOICE_MODELS)

  ipcMain.handle("voice:status", () => voiceStatusSnapshot())

  /**
   * Aquece um motor de ditado em SEGUNDO PLANO: a resposta volta na hora e a
   * carga do modelo corre fora do caminho do usuário. O botão de microfone
   * chama assim que aparece, para o primeiro ditado não esperar o modelo.
   */
  ipcMain.handle(
    "voice:stt:warm",
    (_event, payload: { modelId?: string; engine?: string; threads?: number } = {}) => {
      const modelId = String(payload?.modelId ?? "")
      // O pré-carregamento é uma preferência: desligado, o pedido não aquece
      // nada e a resposta diz isso, em vez de prometer trabalho que não houve.
      const warming = sttPreloadEnabled()
      if (warming) void warmSttModel(modelId || undefined, payload?.engine, payload?.threads)
      return { warming }
    },
  )

  /**
   * Solta na hora o que os motores de ditado carregaram. A aba Voz dispara isto
   * ao desligar o pré-carregamento: a RAM volta na hora, em vez de esperar o
   * ciclo ocioso. Com ditado em curso, o modelo adia a liberação.
   */
  ipcMain.handle("voice:stt:release", () => {
    releaseSttModels()
    return { released: true }
  })

  ipcMain.handle("voice:download", async (_event, payload: { modelId?: string }) => {
    const modelId = String(payload?.modelId ?? "")
    if (!VOICE_MODELS.some((model) => model.id === modelId)) {
      throw new Error(`modelo desconhecido: ${modelId}`)
    }
    // Já está no disco: não há o que baixar, e o que pode faltar é o PREPARO do
    // pacote (extração + VAD), disparado aqui. Sem isto o clique num modelo já
    // baixado não fazia NADA: o download terminava na hora, pulando os arquivos
    // completos, e a tela não mudava.
    if (await isModelDownloaded(modelId)) {
      const model = modelInfo(modelId)
      if (model?.archive) await prepareSttModel(modelId).catch(() => {})
      await emitStatusChanged()
      return { started: false }
    }
    const resultado = startDownload(modelId, (progress: VoiceDownloadProgress) => {
      emitir("voice:download-progress", progress)
      // Fim (ou falha) do download: o estado mudou — avisa e, se for pacote,
      // extrai em seguida (ver `aposDownload`).
      if (progress.done) void aposDownload(modelId, progress)
    })
    // O download começou: "absent" virou "downloading" agora.
    if (resultado.started) void emitStatusChanged()
    return resultado
  })

  ipcMain.handle("voice:download-cancel", (_event, payload: { modelId?: string }) => {
    cancelDownload(String(payload?.modelId ?? ""))
  })

  ipcMain.handle("voice:remove-model", async (_event, payload: { modelId?: string }) => {
    const modelId = String(payload?.modelId ?? "")
    // O motor mantém os ONNX abertos em memória: apagar o TTS com ele de pé
    // deixaria o processo lendo arquivos que não existem mais.
    if (modelId === TTS_MODEL_ID) shutdownTts()
    await removeModel(modelId)
    await emitStatusChanged()
  })

  ipcMain.handle(
    "voice:tts:start",
    (
      _event,
      payload: FalaPedido,
    ): { id: string } => {
      const id = randomUUID()
      const controller = new AbortController()
      falas.set(id, controller)
      const texto = String(payload?.text ?? "")

      // O trabalho segue em segundo plano: o renderer recebe o id na hora e
      // acompanha pelos eventos (é o que o streaming existe para permitir).
      void (async () => {
        try {
          await rodarFala(id, texto, payload, controller.signal)
          emitir("voice:tts:done", { id })
        } catch (err) {
          emitir("voice:tts:done", { id, error: (err as Error).message ?? String(err) })
        } finally {
          falas.delete(id)
        }
      })()

      return { id }
    },
  )

  ipcMain.handle("voice:tts:cancel", (_event, payload: { id?: string }) => {
    falas.get(String(payload?.id ?? ""))?.abort()
  })
}

// ---------------------------------------------------------------------- STT
//
// Ponte para o módulo de STT (outro worker, ./stt.ts): o formato combinado é
// `{ id }` na abertura da sessão + `onPartial(text)` para o texto ao vivo.

export interface VoiceSttSessionStart {
  engine: VoiceEngineId
  /** Taxa do PCM que será empurrado (16 kHz na captura padrão; o motor reamostra). */
  sampleRate: number
  modelId?: string | null
  language?: string
  threads?: number
  /** Texto ao vivo enquanto a fala acontece (padrão: sim). */
  live?: boolean
}

export interface VoiceTranscribeResult {
  text: string
  audioMs: number
  ms: number
}

/** Estado dos motores de ditado — é o retrato que o celular consulta. */
export async function voiceStatus(): Promise<VoiceStatusResponse> {
  const engines = await sttEngineStatus()
  return { ready: engines.some((e) => e.installed && e.available), engines }
}

/**
 * Abre uma sessão de ditado e liga o texto ao vivo. Devolve o id da sessão — é
 * ele que amarra os `pushVoiceSttAudio`/`stopVoiceSttSession` seguintes.
 */
export async function startVoiceSttSession(
  options: VoiceSttSessionStart,
  onPartial: (text: string) => void,
): Promise<{ id: string }> {
  const sessao = await startSttSession(
    {
      engine: options.engine,
      modelId: options.modelId,
      language: options.language,
      threads: options.threads,
      sampleRate: options.sampleRate,
      live: options.live ?? true,
    },
    onPartial,
  )
  return { id: sessao.id }
}

/** Um pedaço de PCM (mesma taxa informada no start) da sessão. */
export function pushVoiceSttAudio(id: string, pcm: Buffer): void {
  pushSttAudio(id, pcm)
}

/** Fim da fala: fecha o último trecho e devolve o texto final. */
export async function stopVoiceSttSession(id: string): Promise<VoiceTranscribeResult> {
  const out = await stopSttSession(id)
  return { text: out.text, audioMs: out.audioMs, ms: out.ms }
}

/** Cancela a sessão sem esperar texto (Esc, janela fechou…). */
export async function cancelVoiceSttSession(id: string): Promise<void> {
  await cancelSttSession(id)
}

/**
 * Transcreve um bloco de PCM de uma vez (áudio já gravado, sem ditado ao vivo):
 * abre a sessão, empurra tudo e fecha. É o caminho de quem manda um recado de
 * voz inteiro (o celular, por exemplo) e não quer sessão aberta.
 *
 * Sem `engine` no pedido, a escolha é: o motor que já está pronto para rodar
 * agora (instalado e disponível) e, se nenhum estiver, o recomendado pelo
 * hardware — a mesma regra que a tela de voz mostra.
 */
export async function transcribePcm(
  pcm: Buffer,
  opts: { sampleRate: number; engine?: VoiceEngineId; modelId?: string | null; language?: string },
): Promise<VoiceTranscribeResult> {
  if (!pcm || pcm.length === 0) throw new Error("PCM vazio")
  const engine = opts.engine ?? (await enginePadrao())
  const { id } = await startVoiceSttSession(
    {
      engine,
      modelId: opts.modelId,
      language: opts.language,
      sampleRate: opts.sampleRate,
      // Sem valor ao vivo: uma passada só, sem parcial no meio do áudio.
      live: false,
    },
    () => {},
  )
  try {
    pushVoiceSttAudio(id, pcm)
  } catch (err) {
    await cancelVoiceSttSession(id)
    throw err
  }
  return await stopVoiceSttSession(id)
}

/** Motor que vale a pena tentar agora: o pronto, senão o recomendado. */
async function enginePadrao(): Promise<VoiceEngineId> {
  const engines = await sttEngineStatus()
  const pronto = engines.find((e) => e.installed && e.available)
  if (pronto) return pronto.engine
  return (await hardware()).recommendedEngine
}

/** Catálogo de STT para quem precisa dele fora do IPC (ex.: validação). */
export function sttModels(): VoiceModelInfo[] {
  return STT_MODELS
}

/** Estado do motor de TTS (diagnóstico: `voice:status` já traz o resumo). */
export async function voiceTtsStatus(): Promise<Awaited<ReturnType<typeof ttsStatus>>> {
  return await ttsStatus()
}

/** Desliga o motor de TTS agora (o desligamento por ociosidade é automático). */
export function shutdownVoice(): void {
  shutdownTts()
}
