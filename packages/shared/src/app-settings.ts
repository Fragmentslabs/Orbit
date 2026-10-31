import type { ReasoningConfig } from './chat'
import { OVERLAY_DEFAULTS, normalizeOverlaySettings, type OverlaySettings } from './overlay'
import { PERSONA_NOTE_MAX, type PersonaStyle } from './persona'
import { USER_NAME_MAX } from './user-name'
import { VOICE_CALL_SILENCE_OPTIONS, VOICE_DEFAULTS, type VoiceEngineId, type VoiceSettings, type VoiceTtsEngine } from './voice'

/**
 * General app settings (Preferences → General and Browser).
 *
 * The renderer is the source of truth (they live in its localStorage) and pushes a
 * copy to the main on every change; the main writes that copy to disk because some
 * of them are worth before any window opens (browser cookies, automatic
 * archiving). The default values reproduce the behavior from before each
 * option existed.
 */

/** How the agent's answer is displayed in the chat. */
export type ChatViewMode =
  /** Reasoning gathered in a single block at the top; actions grouped and collapsed. */
  | 'summary'
  /** Each step in the place where it happened: reasoning and actions in accordions. */
  | 'steps'
  /** Everything open, no accordions: reasoning in full and each action listed. */
  | 'detailed'

/** Where to open links clicked in the app. */
export type LinkTarget = 'integrated' | 'external'

/**
 * Memory routine (Memories screen). The daily capture reads the day's
 * conversations with the auxiliary model and proposes up to 3 memories; the
 * weekly consolidation promotes the ones that repeated. Off by default: it
 * spends tokens.
 */
export type MemoryRoutineMode = 'off' | 'daily' | 'weekly' | 'daily+weekly'

/** For how long the built-in browser keeps cookies and logins. */
export type CookieRetention = 'persistent' | 'until-quit'

/**
 * Where the worktrees created by Orbit (chats and pipeline tasks) live.
 *  - `default`: in the Orbit data folder, outside any project;
 *  - `project`: inside the repository, in .orbit/worktrees (Orbit removes the
 *    folder from git through .git/info/exclude) — visible in the editor;
 *  - `custom`: in a folder chosen by the user.
 * It applies to new worktrees: the existing ones stay where they are.
 */
export type LocalWorktrees = 'default' | 'project' | 'custom'

/**
 * Values and key persisted before this block was translated. They still arrive
 * from the renderer's localStorage and from the copy the main keeps on disk, so
 * the normalization below translates them instead of falling back to the
 * default. Idempotent: current values pass straight through.
 */
const LEGACY_LOCAL_WORKTREES: Record<string, LocalWorktrees> = {
  padrao: 'default',
  projeto: 'project',
  personalizada: 'custom',
}

/**
 * How the agent delivers clicks and keyboard when controlling the computer.
 *  - `directed`: straight to the app (by pid), without moving the user's cursor;
 *  - `global`: through the real pointer — it moves the cursor, and it is the only one that drags.
 */
export type ComputerPointer = 'directed' | 'global'

/** Maximum sides offered for the screenshot (px). */
export const COMPUTER_SCREENSHOT_EDGES = [1024, 1280, 1600] as const

export interface AppSettings {
  /** Model for auxiliary tasks (title, compaction, suggestions). null = the model of the conversation. */
  auxModel: { providerId: string; modelId: string } | null
  /** Reasoning of the auxiliary model. null = no reasoning. */
  auxReasoning: ReasoningConfig | null
  /** Memory routine — run by the scheduler, using the auxiliary model. */
  memoryRoutine: MemoryRoutineMode
  /**
   * How Orbit calls the user ("Hi, Desknik"). Learned in the conversation —
   * never read from the operating system — and editable in the Preferences. null =
   * it does not know yet, and the start screen uses a neutral greeting.
   */
  userName: string | null
  /**
   * How Orbit speaks (Preferences → Behavior). `style` is the starting
   * point; `note` is the adjustment written by the user themself, in their language,
   * and it wins over the style. Nothing here is learned: behavior does not become memory —
   * what is inferred in the conversation dies with it.
   */
  persona: {
    style: PersonaStyle
    /** Free adjustment (≤ PERSONA_NOTE_MAX). Empty = only the style. */
    note: string
  }
  /** Suggests the next message in the input (Tab completes it). */
  promptSuggestions: boolean
  chatView: ChatViewMode
  /** Archives conversations with no activity for N days. null = off. */
  autoArchiveDays: number | null
  /** Deletes conversations archived N days ago (counted from the archiving). null = off. */
  deleteArchivedDays: number | null
  /** Extra rounds on a temporary failure (queue messages). 0 = off. */
  transientRetries: number
  /** Automatic continuations when the answer stops at the step limit. 0 = off. */
  autoContinues: number
  /** Width of the left sidebar, in px (draggable by the edge). */
  sidebarWidth: number
  /** Opens Orbit together with the system (user login). */
  launchAtLogin: boolean
  /** The close button hides to the system tray instead of quitting the app. */
  closeToTray: boolean
  browser: {
    links: LinkTarget
    /** The agent uses the browser on its own (test, capture, document). */
    agentTools: boolean
    cookies: CookieRetention
  }
  worktrees: {
    local: LocalWorktrees
    /** Only with local = 'custom' */
    folder: string | null
  }
  /** Voice core (local TTS and dictation/STT). See voice.ts. */
  voice: VoiceSettings
  /** Computer control (Preferences → Computer). */
  computer: {
    /** Master switch — without it the tools do not even exist, even with the mode on in the conversation. */
    enabled: boolean
    pointer: ComputerPointer
    /** Larger side of the screenshot sent to the model */
    maxScreenshotEdge: number
    /**
     * Model of the Computer Use subagent (computer_task). null = the auxiliary
     * model, if it calls tools; otherwise the one of the conversation (see computer-task.ts).
     * A smaller and faster model shortens each step of the loop.
     */
    model: { providerId: string; modelId: string } | null
  }
  /**
   * Overlay (global shortcut ⇧⌘space): the panel that comes down at the bottom of the screen to
   * ask, translate the selection or talk by voice. See overlay.ts.
   */
  overlay: OverlaySettings
}

/** Sidebar width: 256px is the historical size (16rem), and the ceiling prevents it
 *  from eating the content in a narrow window. The floor is 15rem: below that the
 *  lines (icon + title + badges) get squeezed and the sidebar looks broken. */
export const SIDEBAR_DEFAULT_WIDTH = 256
export const SIDEBAR_MIN_WIDTH = 240
export const SIDEBAR_MAX_WIDTH = 420

/** Brings the width inside the draggable range (used when normalizing and when dragging). */
export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  auxModel: null,
  auxReasoning: null,
  // Off: it spends tokens and the value only proves itself in use.
  memoryRoutine: 'off',
  // No name until the user tells one: the start screen greets without it.
  userName: null,
  // No style and no adjustment: the prompt stays exactly as it was before the option.
  persona: { style: 'default', note: '' },
  promptSuggestions: false,
  chatView: 'summary',
  autoArchiveDays: null,
  deleteArchivedDays: null,
  transientRetries: 3,
  autoContinues: 3,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  // Opening with the system is what makes a routine a routine — the app has to be
  // there to fire it. It comes up with the window closed (wasOpenedAtLogin), so the
  // login is not interrupted, and Preferences can still turn it off.
  launchAtLogin: true,
  // Closing to the tray is the requested behavior (like Claude/Codex): the X
  // hides the app, which stays alive serving the connected apps.
  closeToTray: true,
  browser: {
    links: 'integrated',
    agentTools: true,
    cookies: 'persistent',
  },
  worktrees: {
    local: 'default',
    folder: null,
  },
  // Own copy of the defaults: the voice.ts object is a shared constant and
  // cannot become the target of an accidental edit by the UI.
  voice: { tts: { ...VOICE_DEFAULTS.tts }, stt: { ...VOICE_DEFAULTS.stt }, call: { ...VOICE_DEFAULTS.call } },
  // Controlling the computer is an explicit opt-in; the real pointer, another opt-in.
  computer: {
    enabled: false,
    pointer: 'directed',
    maxScreenshotEdge: 1280,
    model: null,
  },
  // Overlay on by default: it is a shortcut, not a feature that acts on its own —
  // whoever does not want it turns it off in Preferences → Overlay.
  overlay: { ...OVERLAY_DEFAULTS },
}

export const AUTO_ARCHIVE_DAY_OPTIONS = [2, 3, 7, 14, 30, 90] as const
export const DELETE_ARCHIVED_DAY_OPTIONS = [7, 14, 30, 90] as const
export const MAX_TRANSIENT_RETRIES = 5
export const MAX_AUTO_CONTINUES = 5

/**
 * From how many compactions on the offer of continuing in a new chat appears.
 *
 * It is a rule, not a preference: "after three" or "after four" is precision nobody
 * calibrates, and the count alone decides nothing — the offer only happens when the
 * context is ALSO about to force the next compaction, which is the moment the next
 * summary would be a summary of a summary.
 */
export const COMPACT_SUGGEST_AFTER = 2

/** Supertonic 3 voice ids: M1–M5 (male) and F1–F5 (female). */
const VOICE_ID = /^[MF][1-5]$/
/** Short language code (`pt`, `en`, `na`); the STT also accepts `auto`. */
const VOICE_LANG = /^[a-z]{2,8}$/

/**
 * Normalizes the voice block. The Supertonic fields follow the engine contract
 * (voice in the M#/F# format, `speed` between 0.5 and 2 also clamped there), so a
 * value saved outside the domain becomes the default instead of breaking the synthesis.
 */
function voiceSettings(raw: unknown, d: VoiceSettings): VoiceSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoiceSettings>
  const tts = (v.tts && typeof v.tts === 'object' ? v.tts : {}) as Partial<VoiceSettings['tts']>
  const stt = (v.stt && typeof v.stt === 'object' ? v.stt : {}) as Partial<VoiceSettings['stt']>
  const call = (v.call && typeof v.call === 'object' ? v.call : {}) as Partial<VoiceSettings['call']>
  const voiceId = typeof tts.voice === 'string' ? tts.voice.trim().toUpperCase() : ''
  const lang = typeof tts.lang === 'string' ? tts.lang.trim().toLowerCase() : ''
  const speed = typeof tts.speed === 'number' && Number.isFinite(tts.speed)
    ? Math.min(2, Math.max(0.5, tts.speed))
    : d.tts.speed
  const language = typeof stt.language === 'string' ? stt.language.trim().toLowerCase() : ''
  const threads = typeof stt.threads === 'number' && Number.isInteger(stt.threads) && stt.threads >= 1 && stt.threads <= 16
    ? stt.threads
    : d.stt.threads
  return {
    tts: {
      enabled: typeof tts.enabled === 'boolean' ? tts.enabled : d.tts.enabled,
      voice: VOICE_ID.test(voiceId) ? voiceId : d.tts.voice,
      lang: VOICE_LANG.test(lang) ? lang : d.tts.lang,
      speed,
      // Audio priority: a value outside the domain goes back to the default ("model").
      engine: oneOfVoiceTtsEngine(tts.engine, d.tts.engine),
    },
    stt: {
      enabled: typeof stt.enabled === 'boolean' ? stt.enabled : d.stt.enabled,
      engine: oneOfVoiceEngine(stt.engine, d.stt.engine),
      modelId: typeof stt.modelId === 'string' && stt.modelId.trim() ? stt.modelId.trim() : null,
      language: VOICE_LANG.test(language) ? language : d.stt.language,
      live: typeof stt.live === 'boolean' ? stt.live : d.stt.live,
      preload: typeof stt.preload === 'boolean' ? stt.preload : d.stt.preload,
      threads,
      micDeviceId: typeof stt.micDeviceId === 'string' && stt.micDeviceId ? stt.micDeviceId : null,
    },
    call: {
      enabled: typeof call.enabled === 'boolean' ? call.enabled : d.call.enabled,
      // Only the values the screen offers: any saved number goes back to the default.
      silenceMs: (VOICE_CALL_SILENCE_OPTIONS as readonly number[]).includes(call.silenceMs as number)
        ? (call.silenceMs as number)
        : d.call.silenceMs,
    },
  }
}

function oneOfVoiceEngine(value: unknown, fallback: VoiceEngineId): VoiceEngineId {
  return value === 'parakeet' || value === 'whisper' ? value : fallback
}

/** Audio priority of the TTS: `model` (route through the model) or `local`. */
function oneOfVoiceTtsEngine(value: unknown, fallback: VoiceTtsEngine): VoiceTtsEngine {
  return value === 'model' || value === 'local' ? value : fallback
}

/**
 * Completes a partial object (old saved version, or what came from another
 * process) with the defaults, discarding values outside the domain. It never throws.
 */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>
  const d = DEFAULT_APP_SETTINGS
  const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
    options.includes(v as T) ? (v as T) : fallback
  const count = (v: unknown, max: number, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : fallback
  const model = (v: unknown) =>
    v && typeof v === 'object' && typeof (v as { providerId?: unknown }).providerId === 'string' &&
    typeof (v as { modelId?: unknown }).modelId === 'string'
      ? { providerId: (v as { providerId: string }).providerId, modelId: (v as { modelId: string }).modelId }
      : null
  const reasoning = (v: unknown): ReasoningConfig | null =>
    v && typeof v === 'object' && typeof (v as { enabled?: unknown }).enabled === 'boolean'
      ? {
          enabled: (v as ReasoningConfig).enabled,
          variantId: typeof (v as ReasoningConfig).variantId === 'string' ? (v as ReasoningConfig).variantId : undefined,
        }
      : null
  const dayOption = (v: unknown, options: readonly number[]) =>
    typeof v === 'number' && options.includes(v) ? v : null
  // User name: text only, trimmed and with a ceiling. Empty (or only spaces)
  // goes back to being "I do not know" — never an empty string that the greeting would have to
  // treat as a special case.
  const userName =
    typeof value.userName === 'string' ? value.userName.trim().slice(0, USER_NAME_MAX) : ''
  const browser = (value.browser && typeof value.browser === 'object' ? value.browser : {}) as Partial<AppSettings['browser']>
  const sidebarWidth =
    typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth)
      ? clampSidebarWidth(value.sidebarWidth)
      : d.sidebarWidth
  return {
    auxModel: model(value.auxModel),
    auxReasoning: reasoning(value.auxReasoning),
    memoryRoutine: oneOf(value.memoryRoutine, ['off', 'daily', 'weekly', 'daily+weekly'], d.memoryRoutine),
    userName: userName || null,
    persona: (() => {
      const p = (value.persona && typeof value.persona === 'object' ? value.persona : {}) as Partial<AppSettings['persona']>
      return {
        style: oneOf(p.style, ['default', 'direct', 'mentor', 'technical'], d.persona.style),
        // Ceiling only, no trim: the renderer normalizes on every keystroke, and trimming here
        // would swallow the space the user has just typed. Whoever consumes it
        // (personaPromptLines) is the one that trims.
        note: typeof p.note === 'string' ? p.note.slice(0, PERSONA_NOTE_MAX) : '',
      }
    })(),
    promptSuggestions: typeof value.promptSuggestions === 'boolean' ? value.promptSuggestions : d.promptSuggestions,
    chatView: oneOf(value.chatView, ['summary', 'steps', 'detailed'], d.chatView),
    autoArchiveDays: dayOption(value.autoArchiveDays, AUTO_ARCHIVE_DAY_OPTIONS),
    deleteArchivedDays: dayOption(value.deleteArchivedDays, DELETE_ARCHIVED_DAY_OPTIONS),
    transientRetries: count(value.transientRetries, MAX_TRANSIENT_RETRIES, d.transientRetries),
    autoContinues: count(value.autoContinues, MAX_AUTO_CONTINUES, d.autoContinues),
    sidebarWidth,
    launchAtLogin: typeof value.launchAtLogin === 'boolean' ? value.launchAtLogin : d.launchAtLogin,
    closeToTray: typeof value.closeToTray === 'boolean' ? value.closeToTray : d.closeToTray,
    browser: {
      links: oneOf(browser.links, ['integrated', 'external'], d.browser.links),
      agentTools: typeof browser.agentTools === 'boolean' ? browser.agentTools : d.browser.agentTools,
      cookies: oneOf(browser.cookies, ['persistent', 'until-quit'], d.browser.cookies),
    },
    worktrees: (() => {
      const w = (value.worktrees && typeof value.worktrees === 'object' ? value.worktrees : {}) as Partial<AppSettings['worktrees']> & { pasta?: unknown }
      // Settings written before the translation still carry `pasta`.
      const folderRaw = w.folder ?? w.pasta
      const folder = typeof folderRaw === 'string' && folderRaw.trim() ? folderRaw.trim() : null
      const localRaw = w.local
      const local = typeof localRaw === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_LOCAL_WORKTREES, localRaw)
        ? LEGACY_LOCAL_WORKTREES[localRaw]
        : oneOf(localRaw, ['default', 'project', 'custom'], d.worktrees.local)
      // Customized without a chosen folder has nowhere to go: it goes back to the default.
      return local === 'custom' && !folder ? { local: d.worktrees.local, folder: null } : { local, folder }
    })(),
    voice: voiceSettings(value.voice, d.voice),
    computer: (() => {
      const c = (value.computer && typeof value.computer === 'object' ? value.computer : {}) as Partial<AppSettings['computer']>
      return {
        enabled: typeof c.enabled === 'boolean' ? c.enabled : d.computer.enabled,
        pointer: oneOf(c.pointer, ['directed', 'global'], d.computer.pointer),
        maxScreenshotEdge: (COMPUTER_SCREENSHOT_EDGES as readonly number[]).includes(c.maxScreenshotEdge as number)
          ? (c.maxScreenshotEdge as number)
          : d.computer.maxScreenshotEdge,
        model: model(c.model),
      }
    })(),
    overlay: normalizeOverlaySettings(value.overlay),
  }
}
