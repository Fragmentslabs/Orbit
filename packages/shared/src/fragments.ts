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
 */
export type FragmentCapability = "ai" | "models" | "http" | "mcp"

export const FRAGMENT_CAPABILITIES: readonly FragmentCapability[] = ["ai", "models", "http", "mcp"]

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
  /** Shown as a small live card on the home screen (the natural home of a `widget`). */
  home: boolean
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
  /** Bumped on every write; the tab uses it to reload. */
  revision: number
  createdAt: number
  updatedAt: number
  /** The chat the fragment was born in. Which chats worked on it since lives in the artifact
   *  registry (artifacts/chat-registry.ts), the same for every kind of artifact. */
  sessionId?: string
}

/**
 * What a read-only frame (a widget on the home screen) may still ask Orbit: reading its own
 * saved data. Never writes, never the model — a card on the home screen must not spend
 * tokens or change data just by being on screen.
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
