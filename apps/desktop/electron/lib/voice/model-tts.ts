import type { Catalog, CatalogProvider } from "@shared/chat"
import type { VoiceModelTtsStatus } from "@shared/voice"
import { getMergedCatalog } from "../catalog"
import { listCredentialProviders, resolveApiKey } from "../auth"
import { TTS_SAMPLE_RATE } from "./manifest"

/**
 * Rota de fala PELO MODELO (preferência "Modelo de voz").
 *
 * O motor local (Supertonic) é ótimo por ser offline, mas exige ~400 MB de
 * pesos no disco. Quando o usuário já tem um provedor de IA configurado, a
 * mesma fala pode sair do provedor — é a prioridade padrão desta preferência.
 *
 * Aqui só se decide se essa rota EXISTE e como usá-la; o disco e os motores
 * locais continuam sendo do `status.ts`/`tts.ts`. A regra é conservadora:
 * qualquer dúvida (sem provedor, sem chave, sem modelo de fala) vira
 * "indisponível" e o pipeline cai no motor local — a leitura nunca fica muda.
 */

/** Modalidade de SAÍDA que marca um modelo como capaz de gerar fala. */
const AUDIO = "audio"

/**
 * Modelos de fala conhecidos por provedor. O catálogo do models.dev é focado em
 * LLM de texto e costuma não listar os modelos de fala (OpenAI `tts-1`,
 * `gpt-4o-mini-tts`), então a modalidade `audio` sozinha não os encontraria.
 */
const KNOWN_SPEECH_MODEL: Record<string, string> = {
  openai: "gpt-4o-mini-tts",
}

/** Vozes da API de fala da OpenAI, por gênero (o Supertonic usa F#/M#). */
const OPENAI_FEMALE = ["nova", "shimmer", "coral", "sage", "ballad"]
const OPENAI_MALE = ["onyx", "echo", "fable", "ash", "alloy"]

/** Uma rota de fala utilizável: provedor + modelo + URL base. */
export interface SpeechRoute {
  providerId: string
  providerName: string
  /** URL base da API (ex.: `https://api.openai.com/v1`). */
  api: string
  modelId: string
  /** Variáveis de ambiente que podem trazer a chave (ver auth.ts). */
  env: string[]
}

/** A URL base termina em `/v1`? Sem isso não dá para montar o endpoint. */
function joinUrl(api: string, path: string): string {
  return `${api.replace(/\/+$/, "")}/${path}`
}

/**
 * Traduz a voz do Supertonic (F1–F5/M1–M5) para o nome que a API de fala
 * entende. Provedor desconhecido recebe o id original — se ele não aceitar, a
 * chamada falha e o pipeline cai no motor local (que usa o id original).
 */
export function mapSpeechVoice(voice: string | undefined, providerId: string): string {
  const id = (voice ?? "").trim().toUpperCase()
  const match = /^([FM])([1-5])$/.exec(id)
  // Provedor desconhecido recebe o id como veio (talvez ele o entenda); a
  // falha da chamada é o que decide, e o pipeline cai no motor local.
  if (providerId !== "openai") return id || "nova"
  if (!match) return OPENAI_FEMALE[0]
  const table = match[1] === "F" ? OPENAI_FEMALE : OPENAI_MALE
  return table[Number(match[2]) - 1] ?? table[0]
}

/**
 * Escolhe, de forma PURA (testável sem rede), o provedor + modelo de fala.
 * Percorre o catálogo e fica com o primeiro provedor CONFIGURADO (chave salva
 * ou variável de ambiente) que exponha um modelo de fala.
 */
export function pickSpeechRoute(
  catalog: Catalog,
  configured: ReadonlySet<string>,
  env: Record<string, string | undefined> = process.env,
): SpeechRoute | null {
  for (const providerId of Object.keys(catalog)) {
    const provider: CatalogProvider | undefined = catalog[providerId]
    if (!provider?.api) continue
    const hasKey = configured.has(providerId) || (provider.env ?? []).some((name) => Boolean(env[name]))
    if (!hasKey) continue
    const known = KNOWN_SPEECH_MODEL[providerId]
    const fromCatalog = Object.entries(provider.models ?? {}).find(([, model]) =>
      (model.modalities?.output ?? []).includes(AUDIO),
    )?.[0]
    const modelId = fromCatalog ?? known
    if (!modelId) continue
    return {
      providerId,
      providerName: provider.name,
      api: provider.api,
      modelId,
      env: provider.env ?? [],
    }
  }
  return null
}

/** A rota de fala do modelo, agora — ou `null` quando não há nenhuma. */
export async function resolveSpeechRoute(): Promise<SpeechRoute | null> {
  const [catalog, configured] = await Promise.all([getMergedCatalog(), listCredentialProviders()])
  return pickSpeechRoute(catalog, new Set(configured))
}

/**
 * Retrato da rota do modelo para o `voice:status` — a metade da prioridade de
 * áudio que não depende do disco local.
 */
export async function modelTtsStatus(): Promise<VoiceModelTtsStatus> {
  try {
    const route = await resolveSpeechRoute()
    if (!route) {
      return { available: false, reason: "nenhum provedor com modelo de fala configurado" }
    }
    return { available: true, providerId: route.providerId, modelId: route.modelId }
  } catch (err) {
    return { available: false, reason: (err as Error)?.message ?? String(err) }
  }
}

export interface ModelSpeakOptions {
  voice?: string
  lang?: string
  speed?: number
}

export interface ModelSpeakChunk {
  i: number
  n: number
  sr: number
  pcm: Buffer
}

/** Bytes de cada pedaço (par, porque a amostra é de 2 bytes). ~0,17 s a 24 kHz. */
const PCM_CHUNK_BYTES = 8192

/**
 * Sintetiza `text` pelo provedor e entrega o PCM16 em pedaços, no MESMO
 * contrato do motor local (PCM16LE, 24 kHz, mono) — o renderer toca os dois
 * caminhos sem saber a diferença.
 *
 * Pedimos `response_format: "pcm"` justamente por isso: o provedor devolve PCM
 * cru na taxa do contrato, sem cabeçalho para decodificar no caminho do áudio.
 */
export async function speakWithModel(
  text: string,
  options: ModelSpeakOptions,
  onChunk: (chunk: ModelSpeakChunk) => void,
  signal?: AbortSignal,
): Promise<{ pieces: number; audioMs: number }> {
  const texto = String(text ?? "").trim()
  if (!texto) throw new Error("nada para sintetizar: o texto está vazio")

  const route = await resolveSpeechRoute()
  if (!route) throw new Error("nenhum provedor com modelo de fala configurado")
  const apiKey = await resolveApiKey(route.providerId, route.env)

  const response = await fetch(joinUrl(route.api, "audio/speech"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: route.modelId,
      input: texto,
      voice: mapSpeechVoice(options.voice, route.providerId),
      response_format: "pcm",
      ...(typeof options.speed === "number" ? { speed: options.speed } : {}),
    }),
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`o modelo de fala respondeu ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }

  const pcm = Buffer.from(await response.arrayBuffer())
  if (pcm.length === 0) throw new Error("o modelo de fala não devolveu áudio")

  const total = Math.ceil(pcm.length / PCM_CHUNK_BYTES)
  for (let index = 0; index < total; index++) {
    const slice = pcm.subarray(index * PCM_CHUNK_BYTES, (index + 1) * PCM_CHUNK_BYTES)
    onChunk({ i: index, n: total, sr: TTS_SAMPLE_RATE, pcm: slice })
  }

  const bytesPerSample = 2
  return { pieces: total, audioMs: (pcm.length / (TTS_SAMPLE_RATE * bytesPerSample)) * 1000 }
}
