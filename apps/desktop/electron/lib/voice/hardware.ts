import os from "node:os"
import type { VoiceEngineId, VoiceHardwareInfo } from "@shared/voice"
import { STT_MODELS } from "./stt"
import { modelInfo } from "./manifest"

/**
 * Detecção da máquina e recomendação do motor de transcrição.
 *
 * A regra vem das medições do laboratório de voz:
 *  - Parakeet TDT 0.6B v3 pelo `sherpa-onnx` é o preferido (binários prontos
 *    para darwin/win/linux x64 e arm64, N-API, só CPU). Em troca, o processo
 *    cresce ~1,3 GB com o modelo carregado;
 *  - então ele exige memória de verdade: com menos de 16 GB de RAM, o custo em
 *    RAM de um notebook pequeno estoura e vale um modelo menor;
 *  - arch fora de x64/arm64 (ou sistema sem binário do sherpa-onnx) não roda
 *    Parakeet de jeito nenhum — aí a recomendação é whisper.
 *
 * `reason` e `warnings` saem SEMPRE preenchidos: a tela de voz mostra os dois,
 * e recomendação sem justificativa vira caixa-preta para quem usa.
 */

/** id preferido do Parakeet no catálogo do STT (o concreto vem de STT_MODELS). */
export const PARAKEET_MODEL_ID = "parakeet-tdt-0.6b-v3"

/** Abaixo disto, o Parakeet (1,3 GB de RSS) pesa demais na máquina. */
const MIN_MEMORY_GB = 16
/** RAM que o Parakeet ocupa com o modelo carregado (medido no laboratório). */
const PARAKEET_RAM_GB = 1.3

export interface HardwareOptions {
  /** ids de modelos já BAIXADOS (bytes completos no disco) — só para o aviso "ainda não baixado". */
  downloadedIds?: string[]
}

/** O sistema tem binário do sherpa-onnx nesta plataforma? */
function sherpaSupported(platform: string, arch: string): boolean {
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") return false
  return arch === "arm64" || arch === "x64"
}

/**
 * id do catálogo para o motor pedido: usa o id conhecido quando ele existe em
 * STT_MODELS e cai no menor modelo daquele motor quando não existe (o catálogo
 * é do outro worker — a recomendação nunca aponta para um id inventado).
 */
function pickModel(engine: VoiceEngineId, preferredId: string): string {
  if (STT_MODELS.some((model) => model.id === preferredId)) return preferredId
  const same = STT_MODELS.filter((model) => model.engine === engine)
  if (same.length === 0) return preferredId
  return same.reduce((menor, model) => (model.bytes < menor.bytes ? model : menor)).id
}

/** Tamanho em MB "de UI" (decimal, como o HuggingFace e as lojas anunciam). */
function mb(bytes: number): number {
  return Math.round(bytes / 1e6)
}

export function detectHardware(options: HardwareOptions = {}): VoiceHardwareInfo {
  const platform = process.platform
  const arch = os.arch()
  const totalMemGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
  const cpus = Math.max(1, os.cpus().length || 1)
  const baixados = new Set(options.downloadedIds ?? [])
  const warnings: string[] = []

  const rodaParakeet = sherpaSupported(platform, arch)
  const memoriaSuficiente = totalMemGb >= MIN_MEMORY_GB
  const recommendedEngine: VoiceEngineId = rodaParakeet && memoriaSuficiente ? "parakeet" : "whisper"
  const recommendedModel = pickModel(recommendedEngine, PARAKEET_MODEL_ID)

  let reason: string
  if (!rodaParakeet) {
    reason = `Sem binário do sherpa-onnx para ${platform}/${arch}: o Parakeet não roda aqui, então a recomendação é o whisper (${arch} fora de x64/arm64 ou sistema não coberto).`
  } else if (!memoriaSuficiente) {
    reason = `A máquina tem ${totalMemGb} GB de RAM (abaixo de ${MIN_MEMORY_GB} GB): o Parakeet carrega ~${PARAKEET_RAM_GB} GB em memória, então vale um modelo de whisper menor para não pesar.`
  } else {
    reason = `Parakeet TDT 0.6B v3 em CPU pelo sherpa-onnx: binário pronto para ${platform}/${arch}, sem compilar nada, e a máquina tem ${totalMemGb} GB de RAM para os ~${PARAKEET_RAM_GB} GB que ele carrega.`
  }

  if (rodaParakeet && !memoriaSuficiente) {
    warnings.push(`Memória baixa: ${totalMemGb} GB. Com o Parakeet carregado o processo cresce ~${PARAKEET_RAM_GB} GB — em máquina de 8 GB isso trava o resto do app.`)
  }
  if (cpus < 4) {
    warnings.push(`Só ${cpus} núcleo(s) de CPU: use 2 threads no ditado (acima disso a inferência não melhora e o app fica sem folga).`)
  }
  if (platform === "darwin" && arch === "x64") {
    warnings.push("macOS em x64 (Intel): o Parakeet roda em CPU, bem mais devagar que no Apple Silicon.")
  }
  if (platform === "win32") {
    warnings.push("No Windows as APIs de voz novas do sistema estão em preview e só aceitam inglês — por isso o app leva o próprio modelo.")
  }
  if (platform === "darwin") {
    warnings.push("No macOS 26 existiria o reconhecedor de fala do próprio sistema; aqui os motores do app são só parakeet e whisper.")
  }
  if (platform === "linux") {
    warnings.push("No Linux não há motor de fala no sistema: o modelo é sempre o do app.")
  }

  const info = modelInfo(recommendedModel)
  if (info && !baixados.has(recommendedModel)) {
    warnings.push(`O modelo recomendado (${recommendedModel}) ainda não está baixado — baixe em Configurações → Voz (~${mb(info.bytes)} MB).`)
  }

  return { platform, arch, totalMemGb, cpus, recommendedEngine, recommendedModel, reason, warnings }
}
