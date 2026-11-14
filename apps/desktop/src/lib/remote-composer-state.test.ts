import { describe, expect, it } from "vitest"
import type { CatalogModel } from "@shared/chat"
import { EMPTY_SYNC, type RemoteSync } from "@/src/lib/remote-sync"
import {
  attachmentsFit,
  buildRemoteOptions,
  buildRemoteSend,
  remoteModeActive,
  remoteModel,
  remotePermission,
  remoteThinking,
  type RemoteComposerState,
} from "./remote-composer-state"

const defaults = { simple: false, brain: true, thinking: false, search: false, browser: false, plan: false, subagents: false, orchestra: false, vision: false }
const sync = (patch: Partial<RemoteSync> = {}): RemoteSync => ({ ...EMPTY_SYNC, ...patch })
const model = { providerId: "anthropic", modelId: "opus" }

describe("remote composer resolution", () => {
  it("prefers the chat's own model over the machine default", () => {
    expect(remoteModel(sync({ models: { a: { providerId: "x", modelId: "y" } } }), "a", model)).toEqual({ providerId: "x", modelId: "y" })
    expect(remoteModel(sync(), "a", model)).toEqual(model)
    expect(remoteModel(sync(), undefined, null)).toBeNull()
  })

  it("reads a mode from the chat, falling back to the app default of that kind", () => {
    const s = sync({ modes: { search: { a: true } }, appPrefs: { chatModes: defaults, codeModes: { ...defaults, brain: false, plan: true }, permissionMode: "full", autoCreateFolders: false } })
    expect(remoteModeActive(s, "chat", "search", "a")).toBe(true)
    expect(remoteModeActive(s, "chat", "search", "b")).toBe(false)
    expect(remoteModeActive(s, "chat", "brain", "b")).toBe(true)
    expect(remoteModeActive(s, "code", "brain", undefined)).toBe(false)
    expect(remoteModeActive(s, "code", "plan", undefined)).toBe(true)
  })

  it("resolves the permission: chat, then the machine's preference, then ask", () => {
    expect(remotePermission(sync({ prefs: { reasoning: {}, permission: { a: "approve" } } }), "a")).toBe("approve")
    expect(remotePermission(sync({ appPrefs: { chatModes: defaults, codeModes: defaults, permissionMode: "full", autoCreateFolders: false } }), "a")).toBe("full")
    expect(remotePermission(sync(), "a")).toBe("ask")
  })

  it("clamps the thinking level to what the model offers and honours always-on reasoning", () => {
    const info = { variants: [{ id: "low" }, { id: "high" }] } as unknown as CatalogModel
    const s = sync({ prefs: { reasoning: { a: { enabled: true, variantId: "medium" } }, permission: {} } })
    const r = remoteThinking(s, "a", model, info, "chat")
    expect(r.enabled).toBe(true)
    expect(["low", "high"]).toContain(r.variantId)
    const always = remoteThinking(sync(), "a", model, { reasoningAlwaysOn: true } as CatalogModel, "chat")
    expect(always).toMatchObject({ enabled: true, canDisable: false })
  })

  it("uses the per-model thinking when the chat has none", () => {
    const s = sync({ reasoning: { "anthropic/opus": { enabled: true, variantId: "high" } } })
    expect(remoteThinking(s, "a", model, undefined, "code")).toMatchObject({ enabled: true, variantId: "high" })
  })
})

describe("remote send payload", () => {
  const state = (patch: Partial<RemoteComposerState> = {}): RemoteComposerState => ({
    kind: "code",
    model,
    modes: { search: true, plan: false, simple: false, brain: true, subagents: true, vision: true },
    permission: "approve",
    thinking: { enabled: true, variantId: "high" },
    ...patch,
  })

  it("builds the phone's options, with code-only fields only in code", () => {
    expect(buildRemoteOptions(state())).toMatchObject({ research: true, browser: true, brain: true, plan: false, subagents: true, permissionMode: "approve", reasoning: { enabled: true, variantId: "high" } })
    const chat = buildRemoteOptions(state({ kind: "chat" }))
    expect(chat).not.toHaveProperty("permissionMode")
    expect(chat).not.toHaveProperty("plan")
  })

  it("carries the model, the delegated models only when their mode is on, files and folder", () => {
    const s = sync({ workerConfig: { workerModel: { providerId: "w", modelId: "m" }, workerReasoning: null, visionModel: { providerId: "v", modelId: "m" } } })
    const file = { id: "1", type: "file" as const, mime: "image/png", url: "data:image/png;base64,AAA" }
    const send = buildRemoteSend(state(), s, { files: [file], directory: "/work" })
    expect(send).toMatchObject({ providerId: "anthropic", modelId: "opus", workerModel: { providerId: "w" }, visionModel: { providerId: "v" }, directory: "/work", files: [file] })
    const off = buildRemoteSend(state({ modes: { subagents: false, vision: false } }), s, {})
    expect(off).not.toHaveProperty("workerModel")
    expect(off).not.toHaveProperty("visionModel")
    expect(off).not.toHaveProperty("files")
  })

  it("refuses attachments past the wire limit", () => {
    const big = { id: "1", type: "file" as const, mime: "x", url: "d".repeat(2_000_000) }
    expect(attachmentsFit([big])).toBe(false)
    expect(attachmentsFit(undefined)).toBe(true)
  })
})
