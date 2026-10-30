import type { Catalog, CatalogProvider } from "@shared/chat"
import type { VoiceModelTtsStatus } from "@shared/voice"
import { getMergedCatalog } from "../catalog"
import { listCredentialProviders, resolveApiKey } from "../auth"
import { TTS_SAMPLE_RATE } from "./manifest"

/**
 * Speech route THROUGH THE MODEL ("Voice model" preference).
 *
 * The local engine (Supertonic) is great for being offline, but it requires ~400 MB of
 * weights on disk. When the user already has an AI provider configured, the
 * same speech can come from the provider — it is the default priority of this preference.
 *
 * Here we only decide whether that route EXISTS and how to use it; the disk and the local
 * engines remain with `status.ts`/`tts.ts`. The rule is conservative:
 * any doubt (no provider, no key, no speech model) becomes
 * "unavailable" and the pipeline falls back to the local engine — the reading is never mute.
 */

/** OUTPUT modality that marks a model as capable of generating speech. */
const AUDIO = "audio"

/**
 * Speech models known per provider. The models.dev catalog focuses on
 * text LLMs and usually does not list the speech models (OpenAI `tts-1`,
 * `gpt-4o-mini-tts`), so the `audio` modality alone would not find them.
 */
const KNOWN_SPEECH_MODEL: Record<string, string> = {
  openai: "gpt-4o-mini-tts",
}

/** Voices of the OpenAI speech API, by gender (Supertonic uses F#/M#). */
const OPENAI_FEMALE = ["nova", "shimmer", "coral", "sage", "ballad"]
const OPENAI_MALE = ["onyx", "echo", "fable", "ash", "alloy"]

/** A usable speech route: provider + model + base URL. */
export interface SpeechRoute {
  providerId: string
  providerName: string
  /** Base URL of the API (e.g. `https://api.openai.com/v1`). */
  api: string
  modelId: string
  /** Environment variables that may carry the key (see auth.ts). */
  env: string[]
}

/** Does the base URL end in `/v1`? Without it the endpoint cannot be built. */
function joinUrl(api: string, path: string): string {
  return `${api.replace(/\/+$/, "")}/${path}`
}

/**
 * Translates the Supertonic voice (F1–F5/M1–M5) to the name the speech API
 * understands. An unknown provider receives the original id — if it does not accept it, the
 * call fails and the pipeline falls back to the local engine (which uses the original id).
 */
export function mapSpeechVoice(voice: string | undefined, providerId: string): string {
  const id = (voice ?? "").trim().toUpperCase()
  const match = /^([FM])([1-5])$/.exec(id)
  // An unknown provider receives the id as it came (maybe it understands it); the
  // call failure is what decides, and the pipeline falls back to the local engine.
  if (providerId !== "openai") return id || "nova"
  if (!match) return OPENAI_FEMALE[0]
  const table = match[1] === "F" ? OPENAI_FEMALE : OPENAI_MALE
  return table[Number(match[2]) - 1] ?? table[0]
}

/**
 * Chooses, PURELY (testable without the network), the provider + speech model.
 * It walks the catalog and keeps the first CONFIGURED provider (saved key
 * or environment variable) that exposes a speech model.
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

/** The model's speech route, right now — or `null` when there is none. */
export async function resolveSpeechRoute(): Promise<SpeechRoute | null> {
  const [catalog, configured] = await Promise.all([getMergedCatalog(), listCredentialProviders()])
  return pickSpeechRoute(catalog, new Set(configured))
}

/**
 * Snapshot of the model route for `voice:status` — the half of the audio
 * priority that does not depend on the local disk.
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

/** Bytes of each chunk (even, because the sample is 2 bytes). ~0.17 s at 24 kHz. */
const PCM_CHUNK_BYTES = 8192

/**
 * Synthesises `text` through the provider and delivers the PCM16 in chunks, in the SAME
 * contract as the local engine (PCM16LE, 24 kHz, mono) — the renderer plays both
 * paths without knowing the difference.
 *
 * We ask for `response_format: "pcm"` precisely for that: the provider returns raw
 * PCM at the contract rate, with no header to decode on the audio path.
 */
export async function speakWithModel(
  text: string,
  options: ModelSpeakOptions,
  onChunk: (chunk: ModelSpeakChunk) => void,
  signal?: AbortSignal,
): Promise<{ pieces: number; audioMs: number }> {
  const spoken = String(text ?? "").trim()
  if (!spoken) throw new Error("nothing to synthesize: the text is empty")

  const route = await resolveSpeechRoute()
  if (!route) throw new Error("no provider with a speech model configured")
  const apiKey = await resolveApiKey(route.providerId, route.env)

  const response = await fetch(joinUrl(route.api, "audio/speech"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: route.modelId,
      input: spoken,
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
  if (pcm.length === 0) throw new Error("the speech model returned no audio")

  const total = Math.ceil(pcm.length / PCM_CHUNK_BYTES)
  for (let index = 0; index < total; index++) {
    const slice = pcm.subarray(index * PCM_CHUNK_BYTES, (index + 1) * PCM_CHUNK_BYTES)
    onChunk({ i: index, n: total, sr: TTS_SAMPLE_RATE, pcm: slice })
  }

  const bytesPerSample = 2
  return { pieces: total, audioMs: (pcm.length / (TTS_SAMPLE_RATE * bytesPerSample)) * 1000 }
}
