/**
 * Fragments: light screens the agent builds and edits live, served by Orbit
 * (orbit-fragment://) inside a sandboxed iframe of the side panel.
 *
 * The page is the only place with the fragment's code. Everything it does outside
 * itself goes through `window.orbit`, whose calls Orbit executes in the main process
 * — and only for what the user allowed.
 */

export const FRAGMENT_SCHEME = "orbit-fragment"

/** `frag-<slug>-<hex>`: lowercase letters, digits and hyphens, because it is a URL host and a folder name. */
export const FRAGMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}$/

export function isFragmentId(id: unknown): id is string {
  return typeof id === "string" && FRAGMENT_ID_PATTERN.test(id)
}

/**
 * Capabilities a fragment can ask for. The USER grants them, never the agent.
 * - `ai`: call the user's model through `orbit.ai`.
 * - `models`: let the fragment's own UI list and pick the model of `orbit.ai` (`orbit.models`).
 *   Granted, it is the fragment — not the app header — that offers the choice.
 * - `notify`: show notifications in the app (`orbit.notify`) — a toast while the window is
 *   in front, a native banner when it is not. The page schedules them and the app keeps
 *   the schedule, so they still fire with the fragment closed (never with Orbit closed).
 * - `microphone`: record audio with `navigator.mediaDevices.getUserMedia`. The ask happens at
 *   the moment the page really asks for it: the app shows the dialog, and only after the person
 *   allows does macOS get asked too. Declaring it in the manifest asks in advance.
 */
export type FragmentCapability = "ai" | "models" | "http" | "mcp" | "notify" | "microphone"

export const FRAGMENT_CAPABILITIES: readonly FragmentCapability[] = ["ai", "models", "http", "mcp", "notify", "microphone"]

/**
 * - `http`: fetch over https from the hosts the manifest declares (`orbit.http`), performed by
 *   the main process. Allowing it allows exactly those hosts.
 * - `mcp`: call the tools of MCP servers the person already connected (`orbit.mcp`), only the
 *   server/tool pairs the manifest declares. Allowing it allows exactly those pairs.
 * In both, widening the declaration afterwards drops the grant: the person approves again.
 */

/** An MCP server and the tools of it that a fragment declared (tool names as the server reports them). */
export interface FragmentMcpAccess {
  server: string
  tools: string[]
}

export const FRAGMENT_MAX_HOSTS = 10
export const FRAGMENT_MAX_MCP_SERVERS = 8
export const FRAGMENT_MAX_MCP_TOOLS = 20

/** How many notifications one fragment may keep scheduled at once. */
export const FRAGMENT_MAX_NOTIFICATIONS = 20
/** Shortest recurring interval a fragment may ask for, in minutes. */
export const FRAGMENT_NOTIFY_MIN_MINUTES = 1
export const FRAGMENT_NOTIFY_MAX_TITLE = 120
export const FRAGMENT_NOTIFY_MAX_BODY = 300
/** Identity of a schedule inside its fragment: re-scheduling the same id updates it. */
export const FRAGMENT_NOTIFY_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
/** "HH:MM", local time. */
export const FRAGMENT_DAILY_AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * A notification a fragment scheduled. Kept by the APP, not by the page: it survives a
 * reload and fires with the fragment closed — as long as Orbit is open.
 */
export interface FragmentNotification {
  /** Identity inside the fragment (re-scheduling the same id updates it). */
  id: string
  title: string
  body: string
  /** Every day at `HH:MM`, local time. */
  dailyAt?: string
  /** Every N minutes (at least FRAGMENT_NOTIFY_MIN_MINUTES). */
  everyMinutes?: number
  /** One-shot: epoch ms. */
  at?: number
  /** Next firing, epoch ms — computed and advanced by the app. */
  nextAt: number
  createdAt: number
}

/** What a notification needs to become a toast: who sent it and what to show. */
export interface FragmentNotifyEvent {
  fragmentId: string
  fragmentName: string
  /** Lucide icon name of the fragment. */
  icon: string
  title: string
  body: string
  at: number
}

/** The three states of a capability, from the page's point of view. */
export type FragmentPermissionState = "granted" | "not_requested" | "denied"

/**
 * The page asked again about a capability the person has not allowed — sent to the window(s)
 * showing the fragment, so the notice above it comes back even if it had been dismissed.
 */
export interface FragmentPermissionAskEvent {
  fragmentId: string
  capability: FragmentCapability
}

/**
 * A bare, lowercase DNS name from what the agent wrote ("api.example.com" or a full URL),
 * or null. IP literals, `localhost`, single-label and internal-looking names, ports,
 * credentials and wildcards are refused: a declaration must name a public host.
 */
export function normalizeFragmentHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  let value = raw.trim().toLowerCase()
  if (!value || value.length > 253) return null
  if (value.includes("://")) {
    try {
      const url = new URL(value)
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null
      value = url.hostname
    } catch {
      return null
    }
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value)) return null
  if (/^[0-9.]+$/.test(value)) return null
  const tld = value.slice(value.lastIndexOf(".") + 1)
  if (/^[0-9]+$/.test(tld) || ["local", "localhost", "internal", "lan", "home", "corp", "intranet"].includes(tld)) return null
  return value
}

export function sanitizeFragmentHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const hosts = value.map(normalizeFragmentHost).filter((h): h is string => h !== null)
  return [...new Set(hosts)].slice(0, FRAGMENT_MAX_HOSTS)
}

export function sanitizeFragmentMcp(value: unknown): FragmentMcpAccess[] {
  if (!Array.isArray(value)) return []
  const byServer = new Map<string, Set<string>>()
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const { server, tools } = entry as Partial<FragmentMcpAccess>
    if (typeof server !== "string" || !server.trim() || server.length > 80 || !Array.isArray(tools)) continue
    const set = byServer.get(server) ?? new Set<string>()
    for (const tool of tools) {
      if (typeof tool === "string" && tool.trim() && tool.length <= 120) set.add(tool)
    }
    if (set.size > 0) byServer.set(server, set)
  }
  return [...byServer.entries()]
    .slice(0, FRAGMENT_MAX_MCP_SERVERS)
    .map(([server, tools]) => ({ server, tools: [...tools].slice(0, FRAGMENT_MAX_MCP_TOOLS) }))
}

/** True when `next` asks for nothing `prev` did not already ask for (narrowing keeps a grant). */
export function hostsAreSubset(next: string[], prev: string[]): boolean {
  return next.every((h) => prev.includes(h))
}

export function mcpIsSubset(next: FragmentMcpAccess[], prev: FragmentMcpAccess[]): boolean {
  return next.every((n) => prev.some((p) => p.server === n.server && n.tools.every((t) => p.tools.includes(t))))
}

/**
 * Where a fragment is meant to live:
 * - `screen`: a page of the app (the Fragments page, pinnable in the sidebar);
 * - `panel`: a tab of the side panel (pinnable in its "Open" hub).
 * It is the DEFAULT placement; the pins below decide where it is actually reachable.
 */
export type FragmentKind = "screen" | "panel"

export const FRAGMENT_KINDS: readonly FragmentKind[] = ["screen", "panel"]

/**
 * The sizes a widget may occupy on the board beside the chat: a grid of 2 columns by
 * 5 rows. `1x1` is one cell, `2x1` two columns, `1x2` two rows, `2x2` both.
 */
export type FragmentWidgetSize = "1x1" | "2x1" | "1x2" | "2x2"

export const FRAGMENT_WIDGET_SIZES: readonly FragmentWidgetSize[] = ["1x1", "2x1", "1x2", "2x2"]

/** The board holds at most 2 columns by 6 rows. The panel beside the chat shrinks to what is used. */
export const FRAGMENT_WIDGET_COLUMNS = 2
export const FRAGMENT_WIDGET_ROWS = 6
/** One cell, in CSS pixels. */
export const FRAGMENT_WIDGET_UNIT = 72
export const FRAGMENT_WIDGET_GAP = 8
/** How many widgets one fragment may offer. */
export const FRAGMENT_MAX_WIDGETS = 8
export const FRAGMENT_WIDGET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/

/**
 * One widget a fragment offers: a small render of itself, drawn for the cell it is given.
 * The page is loaded with `?widget=<id>&size=<size>` and must fill exactly that box —
 * no scaling, no scrollbars. The same page keeps working as a full screen without it.
 */
export interface FragmentWidget {
  id: string
  name: string
  /** The sizes it knows how to draw. The person picks one when placing it. */
  sizes: FragmentWidgetSize[]
  /** Screen of the fragment a click opens (a value the fragment's own page understands). */
  destination?: string
  /** One line shown while choosing it. */
  description?: string
}

/** A widget placed on the board: which fragment offers it, which widget of it, at which size. */
export interface FragmentWidgetPlacement {
  fragmentId: string
  widgetId: string
  /** The cell it sits on. Absent only on boards saved before the board had free placement. */
  col?: number
  row?: number
  /** The size the person chose; absent = the largest one that fits. */
  size?: FragmentWidgetSize
  /**
   * The board page it sits on; absent = 0. A page is a board of its own — its own cells,
   * its own rows — and the same widget can only be on one of them.
   */
  page?: number
}

/** The model a fragment's `orbit.ai` uses when the user picks one for it. */
export interface FragmentModel {
  providerId: string
  modelId: string
}

/** How much the fragment's model thinks when the page calls `orbit.ai` (the person's choice). */
export interface FragmentReasoning {
  enabled: boolean
  /** The level the model offers (low, high…); absent = the model's default. */
  variantId?: string
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
  /** `null` = thinking off. */
  reasoning?: FragmentReasoning | null
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
  /** Thinking level of that model for `orbit.ai`; absent = off. */
  reasoning?: FragmentReasoning
  /** Major version of the `window.orbit` API this fragment was written against. */
  sdk: 1
  /** What the fragment asked for (written by the agent when it creates the fragment). */
  requests: FragmentCapability[]
  /** What the user allowed (written only by the UI, never by the agent's tools). */
  grants: FragmentCapability[]
  /** Hosts `orbit.http` may reach (https only) — meaningful once "http" is requested and allowed. */
  hosts: string[]
  /** MCP servers and tools `orbit.mcp` may call — meaningful once "mcp" is requested and allowed. */
  mcp: FragmentMcpAccess[]
  /** The widgets this fragment offers to the board beside the chat (never the ones placed: that is the person's). */
  widgets: FragmentWidget[]
  /** Bumped on every write; the tab uses it to reload. */
  revision: number
  createdAt: number
  updatedAt: number
  /** The chat the fragment was born in. Which chats worked on it since lives in the artifact
   *  registry (artifacts/chat-registry.ts), the same for every kind of artifact. */
  sessionId?: string
}

/**
 * What a read-only frame (a widget on the board beside the chat) may still ask Orbit: reading
 * its own saved data. Never writes, never the model — a widget must not spend tokens or
 * change data just by being on screen.
 */
export const FRAGMENT_READ_ONLY_METHODS: readonly string[] = ["store.get", "store.keys"]

/** Methods the page can call through `window.orbit`. */
export type FragmentMethod =
  | "store.get"
  | "store.set"
  | "store.delete"
  | "store.keys"
  | "ai.generate"
  | "models.list"
  | "models.get"
  | "models.set"
  | "http.fetch"
  | "mcp.list"
  | "mcp.call"
  | "notify.show"
  | "notify.schedule"
  | "notify.list"
  | "notify.cancel"
  | "permissions.state"
  | "permissions.request"

/** A model the fragment may offer in its own UI. Names only: never a key, endpoint or price. */
export interface FragmentModelOption {
  providerId: string
  providerName: string
  modelId: string
  name: string
  /** The model can think (the fragment may want to show that). */
  reasoning: boolean
}

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
