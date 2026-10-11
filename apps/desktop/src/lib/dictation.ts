import type { AppSettings } from "@shared/app-settings"
import { VOICE_DEFAULTS, type VoiceSttSettings } from "@shared/voice"

/**
 * Peças puras do ditado: preferências, texto, PCM→base64 e o estado do motor.
 * Vivem fora do hook/componente para poderem ser testadas sem DOM (o resto —
 * microfone, worklet e IPC — só existe dentro do app).
 */

/** Taxa da captura: o contrato do main espera PCM16 mono 16 kHz. */
export const DICTATION_SAMPLE_RATE = 16000

/** Quadros por pedaço enviado ao main: 2048 a 16 kHz = 128 ms. */
export const DICTATION_CHUNK_FRAMES = 2048

/** Nome do processor registrado no worklet (public/pcm-capture-worklet.js). */
export const PCM_WORKLET_PROCESSOR = "orbit-pcm-capture"

export type { VoiceSttSettings }

/** O bloco `voice` vem do AppSettings normalizado, mas pode faltar (localStorage
 *  de uma versão anterior, AppSettings cru num teste): ler daqui nunca lança. */
type VoiceSettingsCarrier = { voice?: { stt?: Partial<VoiceSttSettings> } }

function rawStt(settings: AppSettings | null | undefined): Partial<VoiceSttSettings> | undefined {
  if (!settings) return undefined
  const stt = (settings as unknown as VoiceSettingsCarrier).voice?.stt
  return stt && typeof stt === "object" ? stt : undefined
}

const str = (value: unknown, fallback: string): string => (typeof value === "string" && value ? value : fallback)
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback)

/** Preferências do ditado, com os padrões compartilhados quando falta o bloco. */
export function resolveVoiceSttSettings(settings: AppSettings | null | undefined): VoiceSttSettings {
  const stt = rawStt(settings)
  const d = VOICE_DEFAULTS.stt
  return {
    enabled: bool(stt?.enabled, d.enabled),
    // O motor vem de um seletor que só oferece os ids do contrato; um valor
    // estranho salvo em disco morre no start, com erro do próprio main.
    engine: str(stt?.engine, d.engine) as VoiceSttSettings["engine"],
    modelId: typeof stt?.modelId === "string" && stt.modelId ? stt.modelId : null,
    language: str(stt?.language, d.language),
    live: bool(stt?.live, d.live),
    threads: typeof stt?.threads === "number" && Number.isFinite(stt.threads) ? stt.threads : d.threads,
    preload: bool(stt?.preload, d.preload),
  }
}

export interface VoiceStatusItem {
  id: string
  /** Motor dono do item, quando o payload informa. */
  engine?: string
  downloaded?: boolean
  available?: boolean
}

export interface VoiceStatus {
  engines: VoiceStatusItem[]
  models: VoiceStatusItem[]
}

/** Aceita o item de uma lista (o id vem de dentro) ou de um mapa por id (o id
 *  vem da chave) — `voice:status` usa as duas formas. */
function toItem(raw: unknown, fallbackId = ""): VoiceStatusItem | null {
  if (typeof raw === "string" && raw) return { id: raw }
  if (typeof raw === "boolean") return fallbackId ? { id: fallbackId, downloaded: raw } : null
  if (!raw || typeof raw !== "object") return fallbackId ? { id: fallbackId } : null
  const value = raw as Record<string, unknown>
  const id = str(fallbackId, str(value.id, str(value.name, str(value.engine, ""))))
  if (!id) return null
  const item: VoiceStatusItem = { id }
  if (typeof value.engine === "string") item.engine = value.engine
  // `installed` e `downloaded` são o mesmo fato com nomes diferentes entre os
  // motores (o Parakeet fala em instalado, o whisper em baixado).
  const downloaded =
    typeof value.downloaded === "boolean"
      ? value.downloaded
      : typeof value.installed === "boolean"
        ? value.installed
        : undefined
  if (downloaded !== undefined) item.downloaded = downloaded
  if (typeof value.available === "boolean") item.available = value.available
  return item
}

function toItems(raw: unknown): VoiceStatusItem[] | null {
  if (Array.isArray(raw)) {
    return raw.map((entry) => toItem(entry)).filter((item): item is VoiceStatusItem => item !== null)
  }
  // `models` chega como mapa por id: { "small": { installed: true } }.
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .map(([key, value]) => toItem(value, key))
      .filter((item): item is VoiceStatusItem => item !== null)
  }
  return null
}

/** Normaliza o payload de `voice:status`. `null` = não deu para entender (aí
 *  nada é bloqueado por conta dele). */
export function parseVoiceStatus(raw: unknown): VoiceStatus | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as { engines?: unknown; models?: unknown }
  const engines = toItems(value.engines)
  const models = toItems(value.models)
  if (!engines && !models) return null
  return { engines: engines ?? [], models: models ?? [] }
}

/**
 * O motor/modelo escolhido está pronto? Sem informação confiável responde
 * `true`: bloquear o botão por um status que não soubemos ler seria pior que
 * deixar o start falhar e mostrar o erro no próprio botão.
 */
export function voiceTargetReady(status: VoiceStatus | null, engine: string, modelId: string | null): boolean {
  if (!status) return true
  // O motor pode aparecer identificado por `id` ou por `engine`, conforme o
  // canal — os dois nomes valem.
  const engineItem = status.engines.find((item) => item.id === engine || item.engine === engine)
  if (engineItem) {
    if (engineItem.available === false) return false
  } else if (status.engines.length > 0) {
    // O main listou os motores que conhece e o escolhido não está entre eles.
    return false
  }
  if (modelId) {
    const matches = status.models.filter((item) => item.id === modelId)
    const model = matches.find((item) => item.engine === engine) ?? matches[0]
    if (!model) return false
    return model.downloaded !== false && model.available !== false
  }
  // Sem modelo escolhido o main usa o recomendado para a máquina: o sinal de
  // que existe modelo no disco é o `installed` do próprio motor.
  return engineItem ? engineItem.downloaded !== false : true
}

/**
 * Junta o texto ditado ao que o usuário já tinha no input — nunca sobrescreve.
 * O separador só entra quando falta: base vazia não ganha espaço na frente e
 * base terminando em espaço/quebra de linha não ganha outro.
 */
export function appendDictation(base: string, addition: string): string {
  const add = addition.trim()
  if (!add) return base
  if (!base) return add
  return /\s$/.test(base) ? base + add : `${base} ${add}`
}

/** PCM16 → base64 (o contrato do IPC manda o áudio como string base64). */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ""
  // Em blocos: `String.fromCharCode(...bytes)` de uma vez estoura a pilha em
  // capturas longas.
  const BLOCK = 8192
  for (let i = 0; i < bytes.length; i += BLOCK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BLOCK))
  }
  return btoa(binary)
}

/** URL do worklet. `public/` é servido na raiz do renderer (dev e build), então
 *  o caminho relativo ao documento vale nos dois — em produção a página vem de
 *  `file://…/dist/index.html` e o worklet está ao lado dela. */
export function pcmWorkletUrl(base: string): string {
  return new URL("pcm-capture-worklet.js", base).href
}

/** Ditado só existe no app: sem a ponte IPC (preview no navegador) não há motor. */
export function dictationSupported(): boolean {
  if (typeof window === "undefined" || !window.ipcRenderer) return false
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return false
  return typeof navigator.mediaDevices.getUserMedia === "function"
}
