import { generateText } from 'ai'
import type { FragmentCallInput, FragmentCallResult, FragmentCapability, FragmentManifest } from '@shared/fragments'
import { resolveModel } from '../providers'
import { isUsableModel, listUsableModels } from './fragment-models'
import { getFragment, storeDelete, storeGet, storeKeys, storeSet, updateFragmentMeta } from './fragment-store'
import { modelForSession } from './session-model'
import { buildProviderOptions } from '../reasoning'
import type { SendMessageInput } from '@shared/chat'

/**
 * The broker: every `window.orbit` call of a fragment lands here, in the main process.
 *
 * The page asks, Orbit decides. A call needs (1) a known method, (2) the capability
 * declared by the fragment AND granted by the user, and (3) to stay inside the budgets
 * below. The page never sees a key, a provider or a path — only the answer.
 */

/** Which capability each method needs (absent = always available to the fragment itself). */
const METHOD_CAPABILITY: Record<string, FragmentCapability | undefined> = {
  'store.get': undefined,
  'store.set': undefined,
  'store.delete': undefined,
  'store.keys': undefined,
  'ai.generate': 'ai',
  // The fragment's own UI offers the model choice — still the user's grant.
  'models.list': 'models',
  'models.get': 'models',
  'models.set': 'models',
}

const AI_MAX_PROMPT_CHARS = 30_000
const AI_MAX_OUTPUT_TOKENS = 4_000
const AI_TIMEOUT_MS = 90_000
/** Budget per fragment so a loop in the page cannot drain the user's quota. */
const AI_MAX_PER_MINUTE = 12
const AI_MAX_CONCURRENT = 2

const aiWindow = new Map<string, number[]>()
const aiInFlight = new Map<string, number>()

function fail(code: string, message: string): FragmentCallResult {
  return { ok: false, error: { code, message } }
}

function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
}

function overBudget(fragmentId: string): string | null {
  if ((aiInFlight.get(fragmentId) ?? 0) >= AI_MAX_CONCURRENT) {
    return `at most ${AI_MAX_CONCURRENT} orbit.ai calls at the same time`
  }
  const now = Date.now()
  const recent = (aiWindow.get(fragmentId) ?? []).filter((t) => now - t < 60_000)
  aiWindow.set(fragmentId, recent)
  if (recent.length >= AI_MAX_PER_MINUTE) return `at most ${AI_MAX_PER_MINUTE} orbit.ai calls per minute`
  recent.push(now)
  return null
}

async function aiGenerate(manifest: FragmentManifest, input: FragmentCallInput, params: Record<string, unknown>): Promise<FragmentCallResult> {
  const prompt = params.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) return fail('invalid_params', 'orbit.ai.generate needs { prompt: string }')
  if (prompt.length > AI_MAX_PROMPT_CHARS) return fail('invalid_params', `prompt too long (limit ${AI_MAX_PROMPT_CHARS} characters)`)
  const system = typeof params.system === 'string' ? params.system.slice(0, 8_000) : undefined

  // The model the person picked for THIS fragment, else the one they chat with.
  const remembered = manifest.model ?? modelForSession(input.sessionId)
  if (!remembered) {
    return fail('no_model', 'No model available yet — send a message in any chat first, then try again.')
  }
  const busy = overBudget(manifest.id)
  if (busy) return fail('rate_limited', busy)

  aiInFlight.set(manifest.id, (aiInFlight.get(manifest.id) ?? 0) + 1)
  try {
    const model = await resolveModel(remembered.providerId, remembered.modelId, { sessionId: input.sessionId })
    // The thinking level the person chose for this fragment's model (same translation to the
    // provider's options as every other call in the app).
    const providerOptions = manifest.reasoning?.enabled
      ? await buildProviderOptions({
          sessionId: input.sessionId ?? 'fragment',
          text: '',
          providerId: remembered.providerId,
          modelId: remembered.modelId,
          mode: 'chat',
          options: { reasoning: manifest.reasoning },
        } satisfies SendMessageInput)
      : undefined
    const { text } = await generateText({
      model,
      providerOptions,
      system,
      prompt,
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(AI_TIMEOUT_MS),
    })
    return { ok: true, value: { text } }
  } catch (err) {
    return fail('ai_failed', err instanceof Error ? err.message : String(err))
  } finally {
    const left = (aiInFlight.get(manifest.id) ?? 1) - 1
    if (left <= 0) aiInFlight.delete(manifest.id)
    else aiInFlight.set(manifest.id, left)
  }
}

/**
 * `orbit.models.set`: the page picks the model of ITS OWN `orbit.ai`. The id pair is checked
 * against the models the person has connected, so a page cannot name a provider they never
 * set up. `null` goes back to following the model of the chat.
 */
async function setModel(manifest: FragmentManifest, params: Record<string, unknown>): Promise<FragmentCallResult> {
  if (params.providerId === null || params.providerId === undefined) {
    await updateFragmentMeta(manifest.id, { model: null })
    return { ok: true, value: null }
  }
  if (!(await isUsableModel(params.providerId, params.modelId))) {
    return fail('invalid_params', 'That model is not available — pick one from orbit.models.list().')
  }
  await updateFragmentMeta(manifest.id, { model: { providerId: String(params.providerId), modelId: String(params.modelId) } })
  return { ok: true, value: null }
}

export async function handleFragmentCall(input: FragmentCallInput): Promise<FragmentCallResult> {
  const manifest = await getFragment(input.fragmentId)
  if (!manifest) return fail('not_found', 'This fragment no longer exists.')
  if (typeof input.method !== 'string' || !Object.prototype.hasOwnProperty.call(METHOD_CAPABILITY, input.method)) {
    return fail('unknown_method', `Unknown method: ${String(input.method).slice(0, 60)}`)
  }
  const needs = METHOD_CAPABILITY[input.method]
  if (needs) {
    if (!manifest.requests.includes(needs)) {
      return fail('permission_denied', `This fragment did not declare "${needs}".`)
    }
    if (!manifest.grants.includes(needs)) {
      return fail('permission_denied', `The user has not allowed "${needs}" for this fragment yet.`)
    }
  }
  const params = objectParams(input.params)
  try {
    switch (input.method) {
      case 'store.get':
        return { ok: true, value: await storeGet(manifest.id, String(params.key ?? '')) }
      case 'store.set':
        await storeSet(manifest.id, String(params.key ?? ''), params.value)
        return { ok: true, value: null }
      case 'store.delete':
        await storeDelete(manifest.id, String(params.key ?? ''))
        return { ok: true, value: null }
      case 'store.keys':
        return { ok: true, value: await storeKeys(manifest.id) }
      case 'ai.generate':
        return await aiGenerate(manifest, input, params)
      case 'models.list':
        return { ok: true, value: await listUsableModels() }
      case 'models.get':
        return { ok: true, value: manifest.model ?? null }
      case 'models.set':
        return await setModel(manifest, params)
      default:
        return fail('unknown_method', 'Unknown method.')
    }
  } catch (err) {
    return fail('failed', err instanceof Error ? err.message : String(err))
  }
}
