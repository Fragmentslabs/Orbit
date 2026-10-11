import type {
  VoiceModelInfo,
  VoiceModelState,
  VoiceModelStatus,
  VoiceStatusSnapshot,
} from "@shared/voice"
import { TTS_MODEL_ID, VOICE_MODELS } from "./manifest"
import { isDownloading, isModelDownloaded, progressOf, receivedBytes } from "./download"
import { parakeetExtractPhase } from "./models-store"
import { modelTtsStatus } from "./model-tts"
import { sttEngineStatus, sttModelInstalled } from "./stt"
import { enginePresent } from "./tts"

/**
 * A ÚNICA fonte de verdade do "dá para usar".
 *
 * Havia duas visões discordando: o downloader chamava de "instalado" assim que
 * os bytes chegavam ao disco, enquanto o motor só considera pronto o que ele
 * consegue RODAR (o pacote do Parakeet extraído e com o VAD Silero). O selo da
 * UI saía de uma e o texto do motivo da outra — "Not installed" ao lado de "o
 * pacote está baixado".
 *
 * Aqui as duas coisas saem do MESMO retrato, por modelo:
 *   - `downloaded`: bytes completos e conferidos no disco (só o downloader sabe);
 *   - `installed` : o motor consegue usar agora (só o motor sabe).
 * Um pacote baixado e ainda não extraído fica `downloaded: true`,
 * `installed: false`, `state: "downloaded"` — honesto e sem ambiguidade.
 */

/** Motivo, em uma frase, do pacote baixado que ainda não está utilizável. */
const REASON_ARCHIVE_NOT_EXTRACTED =
  "o pacote está baixado; falta extrair (e baixar o VAD Silero) antes de usar"

/** Retrato honesto de um modelo: o selo e o motivo saem daqui. */
export async function voiceModelStatus(model: VoiceModelInfo): Promise<VoiceModelStatus> {
  const total = model.bytes
  const received = await receivedBytes(model.id)
  const downloaded = await isModelDownloaded(model.id)
  const archive = model.archive === true
  // Só o pacote (Parakeet) tem extração; nos demais `installed` = `downloaded`.
  const extract = archive ? parakeetExtractPhase() : { phase: "idle" as const, error: null }
  const installed = downloaded && (!archive || sttModelInstalled(model.id))

  let state: VoiceModelState
  let reason: string | undefined
  let error: string | undefined

  if (installed) {
    state = "ready"
  } else if (isDownloading(model.id)) {
    state = "downloading"
    reason = "baixando…"
  } else if (archive && downloaded && extract.phase === "extracting") {
    state = "extracting"
    reason = "extraindo o pacote…"
  } else if (archive && downloaded && extract.phase === "error") {
    state = "error"
    error = extract.error ?? "falha ao extrair o pacote"
    reason = error
  } else if (downloaded) {
    // Só o pacote chega aqui: baixado e ainda não extraído.
    state = "downloaded"
    reason = archive ? REASON_ARCHIVE_NOT_EXTRACTED : undefined
  } else {
    const falha = progressOf(model.id)?.error
    if (falha) {
      state = "error"
      error = falha
      reason = falha
    } else if (received > 0) {
      state = "partial"
      reason = `download incompleto (${received} de ${total} bytes)`
    } else {
      state = "absent"
      reason = "ainda não foi baixado"
    }
  }

  return { downloaded, installed, ready: installed, state, received, total, reason, error }
}

/** O retrato completo que o `voice:status` (e o `voice:status-changed`) publica. */
export async function voiceStatusSnapshot(): Promise<VoiceStatusSnapshot> {
  const models: Record<string, VoiceModelStatus> = {}
  for (const model of VOICE_MODELS) models[model.id] = await voiceModelStatus(model)
  const tts = models[TTS_MODEL_ID]
  return {
    models,
    engines: await sttEngineStatus(),
    // Utilizável AGORA = modelo do Supertonic presente e válido E o motor no build.
    ttsReady: tts?.installed === true && enginePresent(),
    // A prioridade "Modelo de voz" não depende do disco local: quem responde se
    // a rota do provedor existe é o retrato do próprio provedor. Sem ela, o
    // pipeline usa o motor local e a UI explica por quê (ver a tela de voz).
    modelTts: await modelTtsStatus(),
  }
}

/**
 * ids com os bytes completos no disco — alimenta o aviso "ainda não baixado" do
 * `voice:hardware`. É "baixado" de propósito: o Parakeet já conta assim que o
 * pacote chega, porque a extração é automática.
 */
export async function downloadedModelIds(): Promise<string[]> {
  const ids: string[] = []
  for (const model of VOICE_MODELS) {
    if (await isModelDownloaded(model.id)) ids.push(model.id)
  }
  return ids
}
