import { useCallback, useEffect, useMemo, useState } from "react"
import type { PermissionMode, QueuedMessage, SendMessageOptions } from "@shared/chat"
import type { ChatModeKey, SyncSnapshotResponse } from "@shared/companion"
import { peersApi } from "@/src/lib/ipc"
import { useEnvProviders } from "@/src/hooks/use-env-providers"
import {
  REMOTE_MODES,
  buildRemoteOptions,
  remoteModel,
  remoteModelInfo,
  remoteModeActive,
  remotePermission,
  remoteTools,
  remoteThinking,
  type ComposerKind,
  type RemoteComposerState,
} from "@/src/lib/remote-composer-state"
import { EMPTY_SYNC, queueOf } from "@/src/lib/remote-sync"
import { useRemoteSyncStore } from "@/src/stores/remote-sync-store"
import type { SelectedModel } from "@/src/stores/provider-store"

/**
 * The state and the actions behind the composer of another desktop's chat — the counterpart
 * of what chat-input/code-input read from local stores. Reads come from that machine's
 * mirrors (remote-sync-store), writes are the companion requests the phone makes
 * (`models:select`, `modes:select`, `session:prefs-select`, `queue:op`), applied here at once
 * so the picker does not wait for the echo.
 *
 * `sessionId` is the OTHER machine's id; without one (a new chat) the choices live in a draft
 * here and `commitDraft(id)` hands them to the machine once the chat exists — sending them
 * without an id would change that machine's own new-chat screen.
 */

interface Draft {
  model?: SelectedModel
  modes: Partial<Record<ChatModeKey, boolean>>
  permission?: PermissionMode
  thinking?: { enabled: boolean; variantId?: string }
  tools?: string[] | null
}

const NO_DRAFT: Draft = { modes: {} }

export function useRemoteComposer(peerId: string, sessionId: string | undefined, kind: ComposerKind, canControl: boolean) {
  const stored = useRemoteSyncStore((s) => s.byPeer[peerId])
  const load = useRemoteSyncStore((s) => s.load)
  const apply = useRemoteSyncStore((s) => s.apply)
  const { catalog, defaultModel } = useEnvProviders()
  const [draft, setDraft] = useState<Draft>(NO_DRAFT)

  useEffect(() => {
    if (canControl) void load(peerId)
  }, [canControl, peerId, load])
  // A different chat starts from a clean draft.
  useEffect(() => setDraft(NO_DRAFT), [peerId, sessionId])

  const sync = stored ?? EMPTY_SYNC
  const draftMode = !sessionId

  const model = (draftMode && draft.model) || remoteModel(sync, sessionId, defaultModel)
  const info = remoteModelInfo(catalog, model)
  const modes = useMemo(() => {
    const out: Record<string, boolean> = {}
    for (const key of REMOTE_MODES[kind]) out[key] = (draftMode && draft.modes[key]) ?? remoteModeActive(sync, kind, key, sessionId)
    return out
  }, [sync, kind, sessionId, draftMode, draft.modes])
  const permission = (draftMode && draft.permission) || remotePermission(sync, sessionId)
  const baseThinking = remoteThinking(sync, sessionId, model, info, kind)
  const draftThinking = draftMode ? draft.thinking : undefined
  const thinking = useMemo(
    () => (draftThinking ? { ...baseThinking, ...draftThinking, enabled: draftThinking.enabled || !baseThinking.canDisable } : baseThinking),
    [baseThinking.enabled, baseThinking.variantId, baseThinking.canDisable, draftThinking], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const tools = draftMode && draft.tools !== undefined ? draft.tools : remoteTools(sync, sessionId)

  const state = useMemo<RemoteComposerState>(() => ({ kind, model, modes, permission, thinking, tools }), [kind, model, modes, permission, thinking, tools])

  const request = useCallback((payload: { type: string; [key: string]: unknown }) => peersApi.request(peerId, payload).catch(() => {}), [peerId])

  const selectModel = useCallback(
    (next: SelectedModel) => {
      if (!sessionId) return setDraft((d) => ({ ...d, model: next }))
      apply(peerId, { type: "session:model-change", overrides: { ...sync.models, [sessionId]: next } })
      void request({ type: "models:select", ...next, sessionId })
    },
    [sessionId, peerId, sync.models, apply, request],
  )

  const setMode = useCallback(
    (mode: ChatModeKey, value: boolean) => {
      if (!sessionId) return setDraft((d) => ({ ...d, modes: { ...d.modes, [mode]: value } }))
      apply(peerId, { type: "session:mode-change", overrides: { ...sync.modes, [mode]: { ...sync.modes[mode], [sessionId]: value } } })
      void request({ type: "modes:select", mode, value, sessionId })
    },
    [sessionId, peerId, sync.modes, apply, request],
  )

  const setThinking = useCallback(
    (pref: { enabled: boolean; variantId?: string }) => {
      if (!sessionId) return setDraft((d) => ({ ...d, thinking: pref }))
      apply(peerId, { type: "session:prefs-change", prefs: { ...sync.prefs, reasoning: { ...sync.prefs.reasoning, [sessionId]: pref } } })
      void request({ type: "session:prefs-select", sessionId, reasoning: pref })
    },
    [sessionId, peerId, sync.prefs, apply, request],
  )

  const setPermission = useCallback(
    (next: PermissionMode) => {
      if (!sessionId) return setDraft((d) => ({ ...d, permission: next }))
      apply(peerId, { type: "session:prefs-change", prefs: { ...sync.prefs, permission: { ...sync.prefs.permission, [sessionId]: next } } })
      void request({ type: "session:prefs-select", sessionId, permission: next })
    },
    [sessionId, peerId, sync.prefs, apply, request],
  )

  /** The MCP servers of the chat (`null` = all of that machine's), the same request the phone makes. */
  const setTools = useCallback(
    (servers: string[] | null) => {
      if (!sessionId) return setDraft((d) => ({ ...d, tools: servers }))
      apply(peerId, { type: "session:tools-change", overrides: { ...sync.tools, [sessionId]: servers } })
      void request({ type: "tools:select", servers, sessionId })
    },
    [sessionId, peerId, sync.tools, apply, request],
  )

  /** A chat just created on the other machine takes the choices made on the new-chat screen. */
  const commitDraft = useCallback(
    async (id: string) => {
      const jobs: Promise<unknown>[] = []
      if (draft.model) jobs.push(request({ type: "models:select", ...draft.model, sessionId: id }))
      for (const [mode, value] of Object.entries(draft.modes)) jobs.push(request({ type: "modes:select", mode, value, sessionId: id }))
      if (draft.permission) jobs.push(request({ type: "session:prefs-select", sessionId: id, permission: draft.permission }))
      if (draft.tools !== undefined) jobs.push(request({ type: "tools:select", servers: draft.tools, sessionId: id }))
      if (draft.thinking) jobs.push(request({ type: "session:prefs-select", sessionId: id, reasoning: draft.thinking }))
      await Promise.all(jobs)
    },
    [draft, request],
  )

  const queue = queueOf(stored, sessionId)
  const queueOps = useMemo(
    () => ({
      remove: (msgId: string) => sessionId && void request({ type: "queue:op", op: { op: "remove", sessionId, msgId } }),
      moveToFront: (msgId: string) => sessionId && void request({ type: "queue:op", op: { op: "move-to-front", sessionId, msgId } }),
      sendNow: (msgId: string) => sessionId && void request({ type: "queue:op", op: { op: "send-now", sessionId, msgId } }),
    }),
    [sessionId, request],
  )

  /** Puts a message in that machine's queue: it sends it when the chat is free (or at `scheduledAt`). */
  const enqueue = useCallback(
    (msg: Pick<QueuedMessage, "text" | "files" | "scheduledAt">, options: SendMessageOptions = buildRemoteOptions(state), front = false) => {
      if (!sessionId) return
      const item: QueuedMessage = {
        id: crypto.randomUUID(),
        text: msg.text,
        ...(msg.files?.length ? { files: msg.files } : {}),
        options,
        mode: kind,
        sessionId,
        ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
        ...(msg.scheduledAt ? { scheduledAt: msg.scheduledAt } : {}),
        createdAt: Date.now(),
      }
      void request({ type: "queue:op", op: { op: "enqueue", sessionId, msg: item, front } })
    },
    [sessionId, kind, model, state, request],
  )

  return {
    sync: sync as SyncSnapshotResponse,
    state,
    catalog,
    info,
    thinking,
    selectModel,
    setMode,
    setThinking,
    setPermission,
    setTools,
    commitDraft,
    queue,
    queueOps,
    enqueue,
  }
}
