import type { Catalog, CatalogModel, FilePart, PermissionMode, SendMessageOptions } from "@shared/chat"
import { closestVariant } from "@shared/chat"
import type { ChatModeKey } from "@shared/companion"
import type { RemoteSendExtras } from "@shared/peers"
import type { SelectedModel } from "@/src/stores/provider-store"
import type { RemoteSync } from "@/src/lib/remote-sync"

/**
 * What the composer of another desktop shows and sends, derived from that machine's mirrors
 * (`RemoteSync`) — the same resolution rules the phone and the local composer use, written
 * once here so the component stays a layout. All lookups use the OTHER machine's chat id
 * (`undefined` = a new chat, which has no per-chat entry yet and follows the defaults).
 */

export type ComposerKind = "chat" | "code"

/** The per-chat mode toggles of the composer, in the order they are offered. */
export const REMOTE_MODES: Record<ComposerKind, ChatModeKey[]> = {
  chat: ["search", "simple", "brain", "vision"],
  code: ["search", "plan", "simple", "brain", "subagents", "vision"],
}

export function remoteModel(sync: RemoteSync, sessionId: string | undefined, fallback: SelectedModel | null): SelectedModel | null {
  return (sessionId && sync.models[sessionId]) || fallback
}

export function remoteModelInfo(catalog: Catalog, model: SelectedModel | null): CatalogModel | undefined {
  return model ? catalog[model.providerId]?.models[model.modelId] : undefined
}

export function remoteModeActive(sync: RemoteSync, kind: ComposerKind, mode: ChatModeKey, sessionId: string | undefined): boolean {
  const own = sessionId ? sync.modes[mode]?.[sessionId] : undefined
  if (own !== undefined) return own
  const defaults = kind === "code" ? sync.appPrefs?.codeModes : sync.appPrefs?.chatModes
  return defaults ? Boolean(defaults[mode as keyof typeof defaults]) : false
}

/** The servers this chat is narrowed to; null = every server on in the app (the default). */
export function remoteTools(sync: RemoteSync, sessionId: string | undefined): string[] | null {
  return (sessionId && sync.tools[sessionId]) || null
}

export function remotePermission(sync: RemoteSync, sessionId: string | undefined): PermissionMode {
  return (sessionId && sync.prefs.permission[sessionId]) || sync.appPrefs?.permissionMode || "ask"
}

/** Thinking: the chat's own choice, else the model's saved one; the level is clamped to what the model offers. */
export function remoteThinking(
  sync: RemoteSync,
  sessionId: string | undefined,
  model: SelectedModel | null,
  info: CatalogModel | undefined,
  kind: ComposerKind,
): { enabled: boolean; variantId: string | undefined; canDisable: boolean } {
  const own = sessionId ? sync.prefs.reasoning[sessionId] : undefined
  const perModel = model ? sync.reasoning[`${model.providerId}/${model.modelId}`] : undefined
  const pref = own ?? perModel
  const defaults = kind === "code" ? sync.appPrefs?.codeModes : sync.appPrefs?.chatModes
  const variantId = closestVariant(info?.variants?.map((v) => v.id) ?? [], pref?.variantId) ?? pref?.variantId
  return {
    enabled: Boolean(defaults?.thinking || pref?.enabled || info?.reasoningAlwaysOn),
    variantId,
    canDisable: !info?.reasoningAlwaysOn,
  }
}

export interface RemoteComposerState {
  kind: ComposerKind
  model: SelectedModel | null
  modes: Record<string, boolean>
  permission: PermissionMode
  thinking: { enabled: boolean; variantId: string | undefined }
  /** MCP servers of the chat; null/absent = all of that machine's. */
  tools?: string[] | null
}

/** The options of a turn, the same fields the phone's `messages:send` carries. */
export function buildRemoteOptions(state: RemoteComposerState): SendMessageOptions {
  const { kind, modes, permission, thinking, tools } = state
  return {
    research: modes.search,
    browser: modes.search,
    simple: modes.simple,
    brain: modes.brain,
    reasoning: { enabled: thinking.enabled, variantId: thinking.variantId },
    ...(tools ? { toolsServers: tools } : {}),
    ...(kind === "code" ? { plan: modes.plan, subagents: modes.subagents, permissionMode: permission } : {}),
  }
}

/** The whole `peers:send` payload: model, options, delegated models and attachments. */
export function buildRemoteSend(
  state: RemoteComposerState,
  sync: RemoteSync,
  extras: { files?: FilePart[]; directory?: string },
): RemoteSendExtras {
  const usesWorkers = state.kind === "code" && state.modes.subagents
  const { workerModel, workerReasoning, visionModel } = sync.workerConfig
  return {
    ...(state.model ? { providerId: state.model.providerId, modelId: state.model.modelId } : {}),
    options: buildRemoteOptions(state),
    ...(extras.files?.length ? { files: extras.files } : {}),
    ...(usesWorkers && workerModel ? { workerModel: { ...workerModel, reasoning: workerReasoning ?? undefined } } : {}),
    ...(state.modes.vision && visionModel ? { visionModel: { ...visionModel } } : {}),
    ...(extras.directory ? { directory: extras.directory } : {}),
  }
}

/** The wire limit of one message (2 MB) leaves this much for attachments. */
export const MAX_REMOTE_ATTACHMENT_CHARS = 1_800_000

export function attachmentsFit(files: FilePart[] | undefined): boolean {
  return (files ?? []).reduce((sum, f) => sum + f.url.length, 0) <= MAX_REMOTE_ATTACHMENT_CHARS
}
