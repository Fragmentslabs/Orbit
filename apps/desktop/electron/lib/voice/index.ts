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
import type { AppSettings } from "@shared/app-settings"
import { getAppSettings, onAppSettingsChange } from "../app-settings"
import { VOICE_MODELS, TTS_MODEL_ID, modelInfo } from "./manifest"
import { cancelDownload, isModelDownloaded, removeModel, startDownload } from "./download"
import { onParakeetExtractPhaseChange } from "./models-store"
import { speakWithModel } from "./model-tts"
import { downloadedModelIds, voiceStatusSnapshot } from "./status"
import { detectHardware } from "./hardware"
import { shutdownTts, speak, ttsStatus } from "./tts"
import { shutdownWhisperServers } from "./whisper"
import type { SttSegment } from "./engine"
import {
  STT_SAMPLE_RATE,
  concatFloat32,
  encodeWavPcm16,
  float32ToPcm16,
  pcm16ToFloat32,
  resampleLinear,
  samplesToMs,
  splitForSynthesis,
  splitPcmWindows,
} from "./audio"
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
 *   evento "voice:tts:chunk"         -> { id, pcm (base64 PCM16), sr, i, n, seg? }
 *                                     (`seg`: nº da frase, só na fala contínua)
 *   evento "voice:tts:done"          -> { id, error? }
 *   invoke "voice:tts:cancel"        { id } -> void
 *   invoke "voice:tts:stream-start"  { voice?, lang?, speed?, engine? } -> { id }
 *   invoke "voice:tts:stream-append" { id, text }   (frase nova, na ordem)
 *   invoke "voice:tts:stream-clear"  { id }         (descarta as frases ainda não geradas)
 *   invoke "voice:tts:stream-end"    { id }         (não chegam mais frases)
 *                                     fala contínua: chunk/done/cancel como acima
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

/** Fala contínua: frases esperando síntese, na ordem em que chegaram. */
interface Fluxo {
  pedido: FalaPedido
  /** `seg` é dado na CHEGADA da frase (a ordem do append), não na geração: as
   *  descartadas por um clear também consomem número, e o renderer — que conta
   *  as que mandou — continua alinhado com o main. */
  fila: { texto: string; seg: number }[]
  /** Número da próxima frase que chegar (vai nos pedaços como `seg`). */
  proxima: number
  /** Não chegam mais frases: com a fila vazia, a fala termina. */
  fechado: boolean
  rodando: boolean
  signal: AbortSignal
}

const fluxos = new Map<string, Fluxo>()

/**
 * Sintetiza a fila de uma fala contínua, uma frase por vez, sem esperar o
 * renderer tocar nada — a geração corre à frente da reprodução. Termina (com
 * `done`) quando a fala foi fechada e a fila esvaziou, ou no primeiro erro.
 */
async function drenarFluxo(id: string): Promise<void> {
  const fluxo = fluxos.get(id)
  if (!fluxo || fluxo.rodando) return
  fluxo.rodando = true
  try {
    while (fluxo.fila.length > 0 && !fluxo.signal.aborted) {
      const { texto, seg } = fluxo.fila.shift() as { texto: string; seg: number }
      await rodarFala(id, texto, fluxo.pedido, fluxo.signal, seg)
    }
  } catch (err) {
    fluxos.delete(id)
    falas.delete(id)
    // Cancelada pelo renderer (interromper/desligar): ninguém espera mais nada.
    if (!fluxo.signal.aborted) emitir("voice:tts:done", { id, error: (err as Error).message ?? String(err) })
    return
  }
  fluxo.rodando = false
  if (fluxo.signal.aborted) {
    fluxos.delete(id)
    falas.delete(id)
    return
  }
  // Chegou frase enquanto a última era gerada: o laço acima já a pegou; aqui
  // só sobra decidir se a fala acabou.
  if (fluxo.fechado && fluxo.fila.length === 0) {
    fluxos.delete(id)
    falas.delete(id)
    emitir("voice:tts:done", { id })
  }
}

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
async function rodarFala(
  id: string,
  texto: string,
  payload: FalaPedido,
  signal: AbortSignal,
  /** Número da frase na fala contínua: o renderer mostra a frase que está tocando. */
  seg?: number,
): Promise<void> {
  await sintetizar(texto, payload, signal, (chunk) =>
    emitir("voice:tts:chunk", { id, pcm: chunk.pcm.toString("base64"), sr: chunk.sr, i: chunk.i, n: chunk.n, seg }),
  )
}

/**
 * A síntese em si, sem destino fixo: a fala ao vivo manda os pedaços para as
 * janelas (`rodarFala`); o arquivo de áudio do agente (`synthesizeToWav`) os
 * junta num WAV.
 */
async function sintetizar(
  texto: string,
  payload: FalaPedido,
  signal: AbortSignal,
  emitirChunk: (chunk: FalaChunk) => void,
): Promise<void> {
  const pedido = { voice: payload?.voice, lang: payload?.lang, speed: payload?.speed }
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
/**
 * Whisper escolhido como motor do ditado: o `whisper-server` sobe JÁ, junto com o
 * app, em vez de no primeiro aperto do microfone (o spawn + a carga do ggml
 * levam segundos). Trocar para outro motor derruba o servidor na hora.
 *
 * Chamado no boot (com o que está no disco) e a cada mudança das configurações.
 * Respeita o pré-carregamento: desligado, o servidor sobe no primeiro ditado.
 * O próprio servidor se encerra depois de ocioso (ver whisper.ts).
 */
export function syncWhisperServer(next: AppSettings, prev?: AppSettings): void {
  const stt = next.voice.stt
  const before = prev?.voice.stt
  const wanted = stt.enabled && stt.preload && stt.engine === "whisper"
  if (before?.engine === "whisper" && stt.engine !== "whisper") shutdownWhisperServers()
  if (!wanted) return
  const changed =
    !before ||
    before.engine !== stt.engine ||
    before.modelId !== stt.modelId ||
    before.threads !== stt.threads ||
    !before.enabled ||
    !before.preload
  if (changed) void warmSttModel(stt.modelId, "whisper", stt.threads)
}

export function registerVoiceIpc(): void {
  onAppSettingsChange((next, prev) => syncWhisperServer(next, prev))

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
      if (model?.archive) {
        try {
          await prepareSttModel(modelId)
        } catch (err) {
          // O erro morria aqui (`.catch(() => {})`): a extração falhava em
          // silêncio e o botão "Preparar agora" parecia não fazer nada. O aviso
          // vai pelo canal de progresso, que a lista de modelos já mostra.
          const falha: VoiceDownloadProgress = {
            modelId,
            received: 0,
            total: model.bytes,
            done: true,
            error: (err as Error).message ?? String(err),
          }
          emitir("voice:download-progress", falha)
        }
      }
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

  // Fala CONTÍNUA (modo chamada): uma fala só, aberta antes de existir texto, que
  // recebe frases conforme o agente as escreve. O main sintetiza a próxima
  // frase enquanto a anterior ainda toca no renderer — com uma fala por frase,
  // cada uma esperava a anterior terminar de tocar para começar a ser gerada, e
  // o silêncio entre "Claro." e o resto era exatamente esse tempo de síntese.
  // Os pedaços saem pelos mesmos `voice:tts:chunk`/`done`, com o mesmo id.
  ipcMain.handle("voice:tts:stream-start", (_event, payload: FalaPedido = {}): { id: string } => {
    const id = randomUUID()
    const controller = new AbortController()
    falas.set(id, controller)
    fluxos.set(id, { pedido: payload, fila: [], proxima: 0, fechado: false, rodando: false, signal: controller.signal })
    return { id }
  })

  ipcMain.handle("voice:tts:stream-append", (_event, payload: { id?: string; text?: string }) => {
    const fluxo = fluxos.get(String(payload?.id ?? ""))
    const texto = String(payload?.text ?? "").trim()
    if (!fluxo || fluxo.fechado || !texto) return
    fluxo.fila.push({ texto, seg: fluxo.proxima++ })
    void drenarFluxo(String(payload.id))
  })

  // Descarta as frases que ainda não começaram a ser geradas (a fala segue
  // aberta). O modo chamada usa quando o agente parte para as ferramentas: o
  // que ele narrou antes disso, além da frase de espera, não deve ser lido.
  ipcMain.handle("voice:tts:stream-clear", (_event, payload: { id?: string }) => {
    const fluxo = fluxos.get(String(payload?.id ?? ""))
    if (fluxo) fluxo.fila = []
  })

  ipcMain.handle("voice:tts:stream-end", (_event, payload: { id?: string }) => {
    const id = String(payload?.id ?? "")
    const fluxo = fluxos.get(id)
    if (!fluxo) return
    fluxo.fechado = true
    void drenarFluxo(id)
  })

  // Ditado. Os canais faltavam: o renderer chamava `voice:stt:start` e o main
  // respondia "No handler registered" — a ponte abaixo existia sem ninguém
  // ligando-a ao IPC.
  ipcMain.handle(
    "voice:stt:start",
    async (event, payload: Partial<VoiceSttSessionStart> = {}): Promise<{ id: string }> => {
      const sender = event.sender
      // O parcial vai só para a janela que abriu a sessão; o id só existe depois
      // do start, e o motor só produz parcial depois do primeiro push.
      let id = ""
      const sessao = await startVoiceSttSession(
        {
          engine: payload.engine as VoiceEngineId,
          modelId: payload.modelId ?? null,
          language: payload.language,
          threads: payload.threads,
          sampleRate: Number(payload.sampleRate) || 16000,
          live: payload.live ?? true,
        },
        (text) => {
          if (id && !sender.isDestroyed()) sender.send("voice:stt:partial", { id, text })
        },
      )
      id = sessao.id
      // Janela fechada no meio da fala: a sessão (e o motor) não ficam órfãos.
      sender.once("destroyed", () => void cancelVoiceSttSession(id).catch(() => {}))
      return sessao
    },
  )

  ipcMain.handle("voice:stt:push", (_event, payload: { id?: string; pcm?: string }) => {
    if (!payload?.id || !payload.pcm) return
    pushVoiceSttAudio(payload.id, Buffer.from(payload.pcm, "base64"))
  })

  ipcMain.handle("voice:stt:stop", (_event, payload: { id?: string }) =>
    stopVoiceSttSession(String(payload?.id ?? "")),
  )

  ipcMain.handle("voice:stt:cancel", (_event, payload: { id?: string }) =>
    cancelVoiceSttSession(String(payload?.id ?? "")),
  )
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
  /** Trechos com tempo (transcrição de arquivo). */
  timestamps?: boolean
}

export interface VoiceTranscribeResult {
  text: string
  audioMs: number
  ms: number
  segments?: SttSegment[]
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
      timestamps: options.timestamps,
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
  return { text: out.text, audioMs: out.audioMs, ms: out.ms, segments: out.segments }
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
  opts: {
    sampleRate: number
    engine?: VoiceEngineId
    modelId?: string | null
    language?: string
    timestamps?: boolean
  },
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
      timestamps: opts.timestamps,
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

// ------------------------------------------------- arquivos de áudio (tools)

/**
 * Texto → arquivo WAV, pelo mesmo motor da leitura em voz alta (prioridade de
 * áudio das preferências: provedor, com o local como reserva). É o que a tool
 * audio_generate entrega. Texto longo vai em partes (a rota do provedor aceita
 * ~4 mil caracteres por pedido); os pedaços são emendados num arquivo só.
 */
export async function synthesizeToWav(
  text: string,
  opts: { voice?: string; lang?: string; speed?: number } = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<{ wav: Buffer; durationMs: number }> {
  const tts = getAppSettings().voice.tts
  const payload: FalaPedido = {
    voice: opts.voice ?? tts.voice,
    lang: opts.lang ?? tts.lang,
    speed: opts.speed ?? tts.speed,
    engine: tts.engine,
  }
  const pieces: Float32Array[] = []
  let rate = 0
  for (const parte of splitForSynthesis(text)) {
    await sintetizar(parte, payload, signal, (chunk) => {
      const samples = pcm16ToFloat32(chunk.pcm)
      if (!rate) rate = chunk.sr
      // A reserva local pode falar noutra taxa que o provedor: tudo na primeira.
      pieces.push(chunk.sr === rate ? samples : resampleLinear(samples, chunk.sr, rate))
    })
  }
  if (!rate || pieces.length === 0) throw new Error("the speech engine returned no audio")
  const all = concatFloat32(pieces)
  return { wav: encodeWavPcm16(all, rate), durationMs: samplesToMs(all.length, rate) }
}

/**
 * PCM16 mono 16 kHz (de `decodeAudioFile`) → texto, pelo motor de ditado das
 * preferências. Arquivos longos vão em janelas de alguns minutos, cortadas no
 * trecho mais quieto perto de cada fronteira (ver `splitPcmWindows`): o
 * encerramento de uma sessão de ditado tem prazo curto, feito para a fala ao
 * vivo, e um arquivo de meia hora numa sessão só estouraria esse prazo.
 */
export async function transcribeAudioPcm(
  pcm: Buffer,
  opts: { language?: string; timestamps?: boolean } = {},
): Promise<{ text: string; engine: VoiceEngineId; segments: SttSegment[] }> {
  const stt = getAppSettings().voice.stt
  const engines = await sttEngineStatus()
  const escolhido = engines.find((e) => e.engine === stt.engine)
  if (!escolhido?.available || !escolhido.installed) {
    throw new Error(
      `the dictation engine (${stt.engine}) is not ready${escolhido?.reason ? `: ${escolhido.reason}` : ""} — see Settings → Voice`,
    )
  }
  const samples = pcm16ToFloat32(pcm)
  const textos: string[] = []
  const segments: SttSegment[] = []
  for (const [start, end] of splitPcmWindows(samples, STT_SAMPLE_RATE)) {
    const janela = float32ToPcm16(samples.subarray(start, end))
    const out = await transcribePcm(janela, {
      sampleRate: STT_SAMPLE_RATE,
      engine: stt.engine,
      modelId: stt.modelId,
      language: opts.language || stt.language,
      timestamps: opts.timestamps,
    })
    if (out.text.trim()) textos.push(out.text.trim())
    // Os tempos de cada janela começam em zero: desloca para o tempo do arquivo.
    const offset = samplesToMs(start, STT_SAMPLE_RATE)
    for (const seg of out.segments ?? []) {
      segments.push({ startMs: seg.startMs + offset, endMs: seg.endMs + offset, text: seg.text })
    }
  }
  return { text: textos.join(" "), engine: stt.engine, segments }
}
