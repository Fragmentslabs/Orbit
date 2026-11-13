import { generateText } from 'ai'
import type {
  FragmentCallInput,
  FragmentCallResult,
  FragmentCapability,
  FragmentManifest,
  FragmentPermissionState,
} from '@shared/fragments'
import { FRAGMENT_CAPABILITIES } from '@shared/fragments'
import { resolveModel } from '../providers'
import { isUsableModel, listUsableModels } from './fragment-models'
import {
  fragmentEvents,
  getFragment,
  storeDelete,
  storeGet,
  storeKeys,
  storeSet,
  updateFragmentMeta,
} from './fragment-store'
import { cancelNotification, listNotifications, scheduleNotification, showNotificationNow } from './fragment-notify'
import { createBudget } from './fragment-budget'
import { announceAsk } from './fragment-ask'
import { fragmentHttpFetch } from './fragment-http'
import { fragmentMcpCall, fragmentMcpList } from './fragment-mcp'
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
  'http.fetch': 'http',
  'mcp.list': 'mcp',
  'mcp.call': 'mcp',
  'notify.show': 'notify',
  'notify.schedule': 'notify',
  'notify.list': 'notify',
  'notify.cancel': 'notify',
  // Reading the state and ASKING again are always available: they never grant anything,
  // they only let the page show "notifications blocked — turn on" and re-open the ask.
  'permissions.state': undefined,
  'permissions.request': undefined,
}

const AI_MAX_PROMPT_CHARS = 30_000
const AI_MAX_OUTPUT_TOKENS = 4_000
const AI_TIMEOUT_MS = 90_000
const AI_MAX_PER_MINUTE = 12
const AI_MAX_CONCURRENT = 2

/** Budget per fragment so a loop in the page cannot drain the user's quota. */
const aiBudget = createBudget({ label: 'orbit.ai', perMinute: AI_MAX_PER_MINUTE, concurrent: AI_MAX_CONCURRENT })

function fail(code: string, message: string): FragmentCallResult {
  return { ok: false, error: { code, message } }
}

function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
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
  const slot = aiBudget.take(manifest.id)
  if ('refused' in slot) return fail('rate_limited', slot.refused)
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
    slot.release()
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

/** The three states of a capability, as the page sees them. */
function permissionState(manifest: FragmentManifest, capability: FragmentCapability): FragmentPermissionState {
  if (manifest.grants.includes(capability)) return 'granted'
  // Declared but not allowed: the person either has not answered yet or said no.
  return manifest.requests.includes(capability) ? 'denied' : 'not_requested'
}

function requestedCapability(params: Record<string, unknown>): FragmentCapability | null {
  const cap = params.capability
  if (typeof cap !== 'string') return null
  return FRAGMENT_CAPABILITIES.includes(cap as FragmentCapability) ? (cap as FragmentCapability) : null
}

/** `notify.show`: one toast now, through the same caps and the same sound as a scheduled one. */
async function showNotification(manifest: FragmentManifest, params: Record<string, unknown>): Promise<FragmentCallResult> {
  const title = typeof params.title === 'string' ? params.title.replace(/\s+/g, ' ').trim() : ''
  if (!title) return fail('invalid_params', 'orbit.notify.show needs { title: string }')
  const body = typeof params.body === 'string' ? params.body.replace(/\s+/g, ' ').trim() : ''
  await showNotificationNow(manifest, title, body)
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
      case 'http.fetch':
        return await fragmentHttpFetch(manifest, params)
      case 'mcp.list':
        return fragmentMcpList(manifest)
      case 'mcp.call':
        return await fragmentMcpCall(manifest, params)
      case 'notify.show':
        return await showNotification(manifest, params)
      case 'notify.schedule':
        try {
          return { ok: true, value: await scheduleNotification(manifest.id, params) }
        } catch (err) {
          return fail('invalid_params', err instanceof Error ? err.message : String(err))
        }
      case 'notify.list':
        return { ok: true, value: await listNotifications(manifest.id) }
      case 'notify.cancel': {
        const id = typeof params.id === 'string' && params.id ? params.id : undefined
        return { ok: true, value: await cancelNotification(manifest.id, id) }
      }
      case 'permissions.state': {
        const cap = requestedCapability(params)
        if (!cap) return fail('invalid_params', 'orbit.permissions.state needs { capability }')
        return { ok: true, value: permissionState(manifest, cap) }
      }
      case 'permissions.request': {
        const cap = requestedCapability(params)
        if (!cap) return fail('invalid_params', 'orbit.permissions.request needs { capability }')
        // The microphone is the one the page cannot gate: there is no `orbit.microphone` API,
        // it calls getUserMedia directly. Asking here is the same thing — the notice goes up
        // above the fragment, and nothing is granted without the person's click on it.
        if (cap === 'microphone') {
          if (manifest.grants.includes('microphone')) return { ok: true, value: 'granted' }
          const declared = await announceAsk(manifest.id, 'microphone')
          return { ok: true, value: declared ? permissionState(declared, cap) : 'denied' }
        }
        if (!manifest.requests.includes(cap)) {
          // Only a grant request written by the agent can declare; the page can only re-ask.
          return fail('not_requested', `This fragment did not declare "${cap}".`)
        }
        if (!manifest.grants.includes(cap)) {
          fragmentEvents.emit('permission-ask', { fragmentId: manifest.id, capability: cap })
        }
        return { ok: true, value: permissionState(manifest, cap) }
      }
      default:
        return fail('unknown_method', 'Unknown method.')
    }
  } catch (err) {
    return fail('failed', err instanceof Error ? err.message : String(err))
  }
}
