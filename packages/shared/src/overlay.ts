/**
 * Orbit overlay: the window that comes down at the bottom of the screen through the global
 * shortcut (⇧⌘space) to ask, translate what is selected or talk by
 * voice without leaving what the person is doing.
 *
 * Only the contract lives here (preferences + the context the main hands to the
 * renderer when opening). The behavior lives in electron/lib/overlay and in
 * src/components/overlay.
 */

/** How the overlay opens: with the text field or straight into call mode. */
export type OverlayOpenMode = "text" | "call"

export interface OverlaySettings {
  /** Global shortcut on. Off, the overlay only opens from the menu/Preferences. */
  enabled: boolean
  /** Opens already in call mode (requires TTS and dictation on in Preferences → Voice). */
  openInCall: boolean
  /**
   * Model of this mode. `null` = the model selected in the conversation (the same
   * global default of the app).
   */
  model: { providerId: string; modelId: string } | null
  /**
   * Vision mode: the captured screen goes to the vision model (the same one from the
   * vision Preferences, global), which returns a text description. It is the
   * default path because it works with any main model — and it is the only
   * one that sees when the panel model is text only.
   *
   * Off, the image goes straight to the panel model, and only if it has
   * vision; without either, the agent says it cannot look at the screen.
   */
  vision: boolean
  /** Opacity of the panel background (1 = solid). The text never becomes translucent. */
  opacity: number
  /** The persona (Rive) in place of the brand. Without it, the panel shows the static halo. */
  persona: boolean
}

/**
 * Default shortcut. Cmd+Space is the macOS Spotlight; Shift+Cmd+Space is free
 * and it is what most overlay assistants use.
 */
export const OVERLAY_SHORTCUT = "CommandOrControl+Shift+Space"

export const OVERLAY_SHORTCUT_LABEL: Record<string, string> = {
  darwin: "⇧⌘espaço",
  win32: "Ctrl+Shift+Space",
  linux: "Ctrl+Shift+Space",
}

/** Opacity floor: below that the panel vanishes over a light wallpaper. */
export const OVERLAY_OPACITY_MIN = 0.5

export const OVERLAY_DEFAULTS: OverlaySettings = {
  enabled: true,
  // Opens speaking: that is what the shortcut exists for — asking in passing, without
  // stopping what one is doing. Without speech and dictation on (or with the voice
  // model absent) the panel falls back to the text field, with the warning of the reason.
  openInCall: true,
  model: null,
  // Looking at the screen is what the shortcut serves most, and Vision mode is the
  // only path that works with any main model — including a text-only
  // one. With no vision model chosen, the screen stays unreadable to the
  // agent, and it is instructed to say so instead of guessing.
  vision: true,
  opacity: 0.94,
  persona: true,
}

/** Completes a partial/old block, discarding values outside the domain. */
export function normalizeOverlaySettings(raw: unknown): OverlaySettings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<OverlaySettings>
  const model =
    value.model &&
    typeof value.model === "object" &&
    typeof (value.model as { providerId?: unknown }).providerId === "string" &&
    typeof (value.model as { modelId?: unknown }).modelId === "string"
      ? {
          providerId: (value.model as { providerId: string }).providerId,
          modelId: (value.model as { modelId: string }).modelId,
        }
      : null
  const opacity =
    typeof value.opacity === "number" && Number.isFinite(value.opacity)
      ? Math.min(1, Math.max(OVERLAY_OPACITY_MIN, value.opacity))
      : OVERLAY_DEFAULTS.opacity
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : OVERLAY_DEFAULTS.enabled,
    openInCall: typeof value.openInCall === "boolean" ? value.openInCall : OVERLAY_DEFAULTS.openInCall,
    model,
    vision: typeof value.vision === "boolean" ? value.vision : OVERLAY_DEFAULTS.vision,
    opacity,
    persona: typeof value.persona === "boolean" ? value.persona : OVERLAY_DEFAULTS.persona,
  }
}

/**
 * What the main hands to the renderer when the overlay opens. The selection is read
 * BEFORE the window receives focus — after that the foreground app is already
 * Orbit, and there is no other selection to read anymore.
 */
export interface OverlayContext {
  /** Did it open in call mode? */
  call: boolean
  /** Text selected in the app that was in front (null = nothing selected). */
  selection: string | null
  /** App the selection came from, to show where the text came out of. */
  selectionApp: string | null
  settings: OverlaySettings
  at: number
}

/** Events from the main to the overlay. */
export type OverlayEvent =
  /** The agent ended the conversation ("bye, Orbit") — the UI hangs up the call. */
  | { type: "hangup"; reason?: string }
  /** Preferences changed with the overlay open (opacity, persona, model). */
  | { type: "settings"; settings: OverlaySettings }
  /** The selection read after the opening (the panel does not wait for `osascript`). */
  | { type: "selection"; text: string | null; app: string | null }
