/**
 * Fragments: light screens the agent builds and edits live, served by Orbit
 * (orbit-fragment://) inside a sandboxed iframe of the side panel.
 *
 * The page is the only place with the fragment's code. Everything it does outside
 * itself goes through `window.orbit`, whose calls Orbit executes in the main process
 * — and only for what the user allowed.
 */

export const FRAGMENT_SCHEME = "orbit-fragment"

/** Capabilities a fragment can ask for. The USER grants them, never the agent. */
export type FragmentCapability = "ai"

export const FRAGMENT_CAPABILITIES: readonly FragmentCapability[] = ["ai"]

/**
 * Where a fragment is meant to live:
 * - `screen`: a page of the app (the Fragments page, pinnable in the sidebar);
 * - `panel`: a tab of the side panel (pinnable in its "Open" hub);
 * - `widget`: a small card for the home screen (rendered there in a later phase).
 * It is the DEFAULT placement; the pins below decide where it is actually reachable.
 */
export type FragmentKind = "screen" | "panel" | "widget"

export const FRAGMENT_KINDS: readonly FragmentKind[] = ["screen", "panel", "widget"]

/** The model a fragment's `orbit.ai` uses when the user picks one for it. */
export interface FragmentModel {
  providerId: string
  modelId: string
}

/** A lucide icon name in kebab-case ("chart-bar", "wallet"). The UI falls back to a generic one for an unknown name. */
export const FRAGMENT_ICON_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const FRAGMENT_DEFAULT_ICON = "app-window"

export interface FragmentPins {
  /** Listed as its own entry in the sidebar. */
  sidebar: boolean
  /** Listed as its own card in the side panel's "Open" hub. */
  panel: boolean
}

/** What the UI (never the agent) may change about a fragment. */
export interface FragmentMetaPatch {
  name?: string
  /** Lucide icon name, kebab-case. */
  icon?: string
  pinned?: Partial<FragmentPins>
  /** `null` = follow the model of the chat. */
  model?: FragmentModel | null
  /** The chat that edits this fragment. */
  sessionId?: string
}

export interface FragmentManifest {
  /** `frag-<slug>-<hex>`: lowercase letters, digits and hyphens (it is a URL host). */
  id: string
  name: string
  /** Lucide icon name (kebab-case), chosen by the agent and changeable by the person. */
  icon: string
  kind: FragmentKind
  pinned: FragmentPins
  /** Model for `orbit.ai`; absent = the model of the chat the person last used. */
  model?: FragmentModel
  /** Major version of the `window.orbit` API this fragment was written against. */
  sdk: 1
  /** What the fragment asked for (written by the agent when it creates the fragment). */
  requests: FragmentCapability[]
  /** What the user allowed (written only by the UI, never by the agent's tools). */
  grants: FragmentCapability[]
  /** Bumped on every write; the tab uses it to reload. */
  revision: number
  createdAt: number
  updatedAt: number
  /** Chat the fragment was born in. */
  sessionId?: string
}

/** Methods the page can call through `window.orbit`. */
export type FragmentMethod = "store.get" | "store.set" | "store.delete" | "store.keys" | "ai.generate"

export interface FragmentCallInput {
  fragmentId: string
  sessionId?: string
  method: string
  params?: unknown
}

export type FragmentCallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

export interface FragmentLogEntry {
  at: number
  level: "log" | "info" | "warn" | "error"
  message: string
}

export interface FragmentUpdatedEvent {
  fragmentId: string
  revision: number
}
