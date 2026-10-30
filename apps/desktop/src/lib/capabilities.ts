import type { MediaKind } from "@shared/media"

/**
 * Catalog of what Orbit knows how to do and that stays hidden behind the conversation:
 * clickable artifact, document, motion, photo/video editing, generated audio,
 * transcription.
 *
 * It is the single source of three places — the start screen suggestions, the
 * "What does Orbit do?" panel and the sentence that fills the composer. That is why there is only
 * DATA here: the texts live in i18n (`chat.start.items.<id>.label` / `.desc` /
 * `.example` / `.howTo`) and the drawing lives in the components.
 */

export type CapabilityId =
  | "design"
  | "artifact"
  | "document"
  | "presentation"
  | "diagram"
  | "motion"
  | "vector"
  | "photo"
  | "video"
  | "compress"
  | "record"
  | "docx"
  | "audio"
  | "transcript"
  | "voice"
  | "dictation"
  | "memory"
  | "routine"
  | "board"

export type CapabilityGroup = "create" | "media" | "work"

export type CapabilityMode = "chat" | "code"

/**
 * Voice half a capability needs. The gate is the same as the engine's: in
 * `tools/index.ts` the tool is only registered when the half is on — it is not
 * an interface filter, it is the agent that does not see it.
 */
export type VoiceFeature = "tts" | "stt"

/**
 * Resource that must be on for the capability to exist. Voice is the case
 * that shows up the most (the tool is not even registered), but video recording depends
 * on the browser tools for the same reason: without them there is no
 * `browser_record` to run the script.
 */
export type CapabilityRequirement = VoiceFeature | "browser"

export interface Capability {
  id: CapabilityId
  group: CapabilityGroup
  /** Modes in which the capability is offered. */
  modes: readonly CapabilityMode[]
  /**
   * What it leaves in the gallery. It is the only thing the rule "prioritize what
   * it never produced" can query: without `produces`, the capability is never
   * marked as new — and that is why it is never passed over.
   */
  produces?: MediaKind
  /**
   * Does the line have an example sentence that fills the composer? The ones that do not
   * (voice call, dictation) are activated in the input itself and appear in the panel
   * with "where it is", instead of the try button.
   */
  hasExample: boolean
  /**
   * Resource that must be on for the capability to really exist.
   * Off, the screen does not promise what the agent cannot do: the panel
   * offers the enable button and the pills skip the line.
   */
  requires?: CapabilityRequirement
}

/**
 * Reading order of the panel. The start screen rotation starts here and spins,
 * so touching this list also changes which capabilities appear on the day.
 */
export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = ["create", "media", "work"]

export const CAPABILITIES: readonly Capability[] = [
  // Create
  { id: "design", group: "create", modes: ["chat", "code"], hasExample: true },
  { id: "artifact", group: "create", modes: ["chat", "code"], produces: "artifact", hasExample: true },
  { id: "document", group: "create", modes: ["chat", "code"], produces: "document", hasExample: true },
  { id: "presentation", group: "create", modes: ["chat", "code"], hasExample: true },
  { id: "diagram", group: "create", modes: ["chat", "code"], hasExample: true },
  { id: "motion", group: "create", modes: ["chat", "code"], produces: "motion", hasExample: true },
  { id: "vector", group: "create", modes: ["chat", "code"], hasExample: true },

  // Media
  { id: "photo", group: "media", modes: ["chat", "code"], produces: "image", hasExample: true },
  { id: "video", group: "media", modes: ["chat", "code"], produces: "video", hasExample: true },
  // Compression delivers video OR audio, so it does not declare `produces`: the type
  // depends on the request, and lying here would make the start screen count wrong.
  { id: "compress", group: "media", modes: ["chat", "code"], hasExample: true },
  {
    id: "record",
    group: "media",
    modes: ["chat", "code"],
    produces: "video",
    hasExample: true,
    requires: "browser",
  },
  { id: "docx", group: "media", modes: ["chat", "code"], hasExample: true },
  { id: "audio", group: "media", modes: ["chat", "code"], produces: "audio", hasExample: true, requires: "tts" },
  { id: "transcript", group: "media", modes: ["chat", "code"], produces: "document", hasExample: true, requires: "stt" },
  { id: "voice", group: "media", modes: ["chat", "code"], hasExample: false },
  { id: "dictation", group: "media", modes: ["chat", "code"], hasExample: false },

  // Work
  { id: "memory", group: "work", modes: ["chat", "code"], hasExample: true },
  { id: "routine", group: "work", modes: ["chat", "code"], hasExample: true },
  { id: "board", group: "work", modes: ["code"], hasExample: true },
]

export function capabilitiesOfGroup(group: CapabilityGroup): Capability[] {
  return CAPABILITIES.filter((capability) => capability.group === group)
}

export function capabilityById(id: CapabilityId): Capability | undefined {
  return CAPABILITIES.find((capability) => capability.id === id)
}
