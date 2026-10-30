import type { MediaKind } from "@shared/media"
import type { SessionMode } from "@shared/chat"

import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  type Capability,
  type CapabilityGroup,
  type CapabilityId,
} from "./capabilities"

/**
 * The three suggestions of the start screen.
 *
 * The rule that matters: each pill is backed by a fact that is already in
 * memory — a previous session, a working folder, what the gallery says
 * the person has never produced. Nothing here queries the network or disk: it is a pure
 * function, testable, and the start screen stays instant.
 */

export type StartAction =
  /** Opens an existing session. Navigation, not a message. */
  | { kind: "open"; sessionId: string; mode: SessionMode }
  /** Fills the composer. The person is the one who presses Enter. */
  | { kind: "fill"; text: string }

export interface StartSuggestion {
  /** Stable during the day — it is what React uses as key and the test as signature. */
  id: string
  capability?: CapabilityId
  label: string
  action: StartAction
  /** Capability of a family the person has not produced yet. */
  fresh: boolean
}

export interface StartContext {
  mode: SessionMode
  /** Main working folder. In code mode, without it there is nothing to suggest. */
  directory?: string
  /** Recent session of the same mode (and of the same folder, in code). */
  lastSession?: { id: string; title: string; mode: SessionMode }
  /** Media types already produced at some point — comes from the gallery. */
  usedKinds?: readonly MediaKind[]
  /**
   * Voice halves turned on in Settings. When off, the tool does not even exist in the
   * turn (`tools/index.ts`), so the pill would be an empty promise: the
   * capability is skipped here and the panel offers the enable button.
   */
  features?: { tts: boolean; stt: boolean; browser: boolean }
  /** YYYY-MM-DD. Rotation seed: the same all day long. */
  day: string
}

/** Translator already resolved — the builder does not know i18n, and that way it can be tested. */
export type Translate = (key: string, options?: Record<string, unknown>) => string

export const MAX_SUGGESTIONS = 3

export function buildStartSuggestions(ctx: StartContext, t: Translate): StartSuggestion[] {
  // Without a folder the code mode runs nothing: the folder selector lives in the
  // input itself, and a pill here would be a button that leads nowhere.
  if (ctx.mode === "code" && !ctx.directory) return []

  const used = ctx.usedKinds ?? []
  const features = ctx.features ?? { tts: true, stt: true, browser: true }
  const seed = `${ctx.day}:${ctx.mode}`
  const suggestions: StartSuggestion[] = []

  if (ctx.lastSession) {
    suggestions.push({
      id: `resume:${ctx.lastSession.id}`,
      label: t("chat.start.resume", { title: ctx.lastSession.title }),
      action: { kind: "open", sessionId: ctx.lastSession.id, mode: ctx.lastSession.mode },
      fresh: false,
    })
  }

  for (const group of orderedGroups(seed, ctx.mode, used, features)) {
    if (suggestions.length >= MAX_SUGGESTIONS) break
    const capability = pickInGroup(group, ctx.mode, used, features, seed)
    if (!capability) continue
    suggestions.push({
      id: capability.id,
      capability: capability.id,
      label: t(`chat.start.items.${capability.id}.label`),
      action: { kind: "fill", text: t(`chat.start.items.${capability.id}.example`) },
      fresh: isFresh(capability, used),
    })
  }

  return suggestions
}

/**
 * Groups with novelty first, then the rotated order of the day. That way whoever never
 * generated a video sees video before one more document, even if the day's rotation
 * started with "create".
 */
function orderedGroups(
  seed: string,
  mode: SessionMode,
  used: readonly MediaKind[],
  features: { tts: boolean; stt: boolean; browser: boolean },
): CapabilityGroup[] {
  const shift = hash(seed) % CAPABILITY_GROUPS.length
  const rotated = [...CAPABILITY_GROUPS.slice(shift), ...CAPABILITY_GROUPS.slice(0, shift)]
  const withFresh = rotated.filter((group) =>
    CAPABILITIES.some(
      (capability) =>
        capability.group === group &&
        capability.modes.includes(mode) &&
        capability.hasExample &&
        isAvailable(capability, features) &&
        isFresh(capability, used),
    ),
  )
  return [...withFresh, ...rotated.filter((group) => !withFresh.includes(group))]
}

function pickInGroup(
  group: CapabilityGroup,
  mode: SessionMode,
  used: readonly MediaKind[],
  features: { tts: boolean; stt: boolean; browser: boolean },
  seed: string,
): Capability | undefined {
  const pool = CAPABILITIES.filter(
    (capability) =>
      capability.group === group &&
      capability.modes.includes(mode) &&
      capability.hasExample &&
      isAvailable(capability, features),
  )
  if (pool.length === 0) return undefined
  const fresh = pool.filter((capability) => isFresh(capability, used))
  const candidates = fresh.length > 0 ? fresh : pool
  return candidates[hash(`${seed}:${group}`) % candidates.length]
}

/** Resource off = tool missing in the turn. It does not even count as novelty. */
function isAvailable(
  capability: Capability,
  features: { tts: boolean; stt: boolean; browser: boolean },
): boolean {
  if (capability.requires === "tts") return features.tts
  if (capability.requires === "stt") return features.stt
  if (capability.requires === "browser") return features.browser
  return true
}

function isFresh(capability: Capability, used: readonly MediaKind[]): boolean {
  return capability.produces !== undefined && !used.includes(capability.produces)
}

/** FNV-1a: deterministic across processes, unlike Math.random(). */
function hash(input: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value >>> 0
}
