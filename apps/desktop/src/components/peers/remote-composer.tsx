import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { PlusIcon } from "lucide-react"
import type { ChatMessage, FilePart, SendMessageOptions } from "@shared/chat"
import type { RemoteSendExtras } from "@shared/peers"
import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  PromptInput,
  PromptInputProvider,
  PromptInputActionAddAttachments,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
} from "@/src/components/ai/prompt-input"
import { ContextMeterView } from "@/src/components/context-meter"
import { ModeMenuItems } from "@/src/components/mode-menu-items"
import { ModeToggle } from "@/src/components/mode-toggle"
import { ModelPicker } from "@/src/components/model-picker"
import { ToolsPopoverView } from "@/src/components/tools-popover"
import { PermissionModePicker } from "@/src/components/permission-mode-picker"
import { QueueView } from "@/src/components/queue-indicator"
import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { ReplyBar } from "@/src/components/reply-bar"
import { SendButtonGroup } from "@/src/components/send-button-group"
import { SlashPalette } from "@/src/components/slash-palette"
import { useRemoteComposer } from "@/src/hooks/use-remote-composer"
import { useSkillsStore } from "@/src/stores/skills-store"
import { remoteIdOf } from "@/src/hooks/use-remote-session-actions"
import { buildRemoteSend, attachmentsFit, MAX_REMOTE_ATTACHMENT_CHARS, type ComposerKind } from "@/src/lib/remote-composer-state"
import { toFileParts } from "@/src/lib/message-utils"
import { resolveSlashAction } from "@/src/lib/slash-actions"
import { useSlashActionCommands } from "@/src/lib/slash-commands"
import { withReplyPrefix } from "@/src/stores/message-reply"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import { isRemoteRunning, usePeersStore } from "@/src/stores/peers-store"
import { remoteModeToggles, remoteSlashCommands } from "./remote-composer-commands"

const NO_MESSAGES: ChatMessage[] = []

/** A message ready to go: the text and everything the phone's `messages:send` carries. */
export interface RemoteSubmit {
  text: string
  extras: RemoteSendExtras
  /** Hands the choices made on a new-chat screen to the chat just created over there. */
  commitDraft: (remoteSessionId: string) => Promise<void>
}

/**
 * The composer of a chat on another desktop: the same pieces as the local one (prompt box,
 * attachments, "/" palette, model / thinking / permission pickers, queue, context meter, the
 * send/queue/stop group) fed by that machine's mirrors instead of this one's stores — see
 * use-remote-composer. A peer paired for sending only (no `control`) gets the plain box: its
 * model, modes and queue are not this machine's to change.
 *
 * Out of the composer on purpose, because the companion API cannot do them remotely:
 * "@" references (files, skills, MCP), the fragments / hooks controls, voice calls,
 * dictation, orchestra and loop, sending to a side panel, and compacting the context.
 */
export function RemoteComposer({ peerId, sessionId, kind, canControl, placeholder, note, sending, onSubmit }: {
  peerId: string
  /** Namespaced id of the open chat; none = the new-chat screen. */
  sessionId?: string
  kind: ComposerKind
  canControl: boolean
  placeholder: string
  note: string
  sending: boolean
  onSubmit: (message: RemoteSubmit) => Promise<void>
}) {
  const { t } = useTranslation()
  const rawId = sessionId ? remoteIdOf(sessionId) : undefined
  const remote = useRemoteComposer(peerId, rawId, kind, canControl)
  const { state, sync, info, thinking } = remote
  const status = usePeersStore((s) => (sessionId ? s.statuses[sessionId] : undefined))
  const messages = usePeersStore((s) => (sessionId ? s.messages[sessionId] : undefined))
  const live = usePeersStore((s) => (sessionId ? s.liveContext[sessionId] : undefined))
  const abort = usePeersStore((s) => s.abort)
  const modesInRow = useAppearanceStore((s) => s.modesInRow)
  const modeLabelStyle = useAppearanceStore((s) => s.modeLabelStyle)
  const actionCommands = useSlashActionCommands(kind)
  const mcpServers = useSkillsStore((s) => s.mcpServers)
  // The servers of the machine on screen (the store follows the environment selector).
  useEffect(() => {
    if (canControl) void useSkillsStore.getState().refreshServers().catch(() => {})
  }, [canControl, peerId])
  const [error, setError] = useState<string | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const composerRef = useRef<HTMLDivElement>(null)
  const busy = isRemoteRunning(status)
  const replyKey = sessionId ?? `draft:${peerId}`

  const toggles = useMemo(() => remoteModeToggles(kind, state.modes, remote.setMode, t), [kind, state.modes, remote.setMode, t])
  const commands = useMemo(
    () => remoteSlashCommands({ kind, active: state.modes, permission: state.permission, setMode: remote.setMode, setPermission: remote.setPermission, actions: actionCommands, t }),
    [kind, state.modes, state.permission, remote.setMode, remote.setPermission, actionCommands, t],
  )

  const compose = (raw: string) => withReplyPrefix(replyKey, resolveSlashAction(raw, kind)?.prompt ?? raw)

  const submit = async (rawText: string, files: FilePart[]) => {
    const text = rawText.trim()
    if (!text && files.length === 0) return
    if (!attachmentsFit(files)) {
      setError(t("peers.remote.attachmentsTooBig"))
      return
    }
    setError(null)
    const full = compose(text)
    // The chat is running over there: the message waits in THAT machine's queue, which sends it when it is free.
    if (busy && canControl) return remote.enqueue({ text: full, files })
    if (busy) return
    await onSubmit({
      text: full,
      extras: canControl ? buildRemoteSend(state, sync, { files }) : {},
      commitDraft: remote.commitDraft,
    })
  }

  const queueFiles = (files?: { url?: string; mediaType?: string; filename?: string }[]) => toFileParts(files ?? [])
  const options: SendMessageOptions = buildRemoteSend(state, sync, {}).options ?? {}

  return (
    <PromptInputProvider>
      <SlashPalette commands={canControl ? commands : []} className="mx-auto w-full max-w-2xl">
        <div ref={composerRef} className="mx-auto w-full max-w-2xl pb-4 @container">
          {canControl && sessionId ? (
            <QueueView
              items={remote.queue}
              paused={status === "error"}
              onRemove={remote.queueOps.remove}
              onMoveToFront={remote.queueOps.moveToFront}
              onSendNow={remote.queueOps.sendNow}
            />
          ) : null}
          <PromptInput
            multiple={canControl}
            maxFileSize={Math.floor(MAX_REMOTE_ATTACHMENT_CHARS * 0.7)}
            onError={() => setError(t("peers.remote.attachmentsTooBig"))}
            onSubmit={(message) => submit(message.text ?? "", canControl ? toFileParts(message.files ?? []) : [])}
            className="relative rounded-xl border-2 border-sidebar-border [&>div]:!rounded-[calc(var(--radius-xl)-2px)] [&>div]:!border-none [&>div]:!bg-transparent"
          >
            <PromptInputAttachments className="!px-3 !py-1.5" leading={<ReplyBar replyKey={replyKey} />}>
              {(attachment) => <PromptInputAttachment data={attachment} />}
            </PromptInputAttachments>
            <PromptInputBody>
              <PromptInputTextarea placeholder={placeholder} className="px-3 text-base md:text-base" />
            </PromptInputBody>
            <PromptInputFooter>
              <div className="flex items-center gap-1">
                {canControl ? (
                  <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
                    <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground">
                      <PlusIcon className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-56 p-1.5">
                      <ModeMenuItems items={toggles} />
                      <DropdownMenuSeparator />
                      <PromptInputActionAddAttachments label={t("input.attachFiles")} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <span className="truncate px-1 text-[11px] text-muted-foreground">{note}</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {canControl && info?.variants && info.variants.length > 0 ? (
                  <ReasoningPicker
                    compact
                    variants={info.variants}
                    enabled={thinking.enabled}
                    canDisable={thinking.canDisable}
                    selected={thinking.variantId}
                    onSelect={(id) => remote.setThinking({ enabled: id != null, variantId: id ?? undefined })}
                  />
                ) : null}
                {canControl ? (
                  <ModelPicker value={state.model} onValueChange={(m) => m && remote.selectModel(m)} hideRotationOptions />
                ) : null}
                {canControl && kind === "code" ? (
                  <PermissionModePicker value={state.permission} onValueChange={remote.setPermission} />
                ) : null}
                <SendButtonGroup
                  busy={busy}
                  cancelling={status === "cancelling"}
                  disabled={sending}
                  onStop={() => sessionId && void abort(sessionId)}
                  onQueue={(text, files) => remote.enqueue({ text: compose(text), files: queueFiles(files) }, options)}
                  onStopAndSend={(text, files) => {
                    if (sessionId) void abort(sessionId)
                    remote.enqueue({ text: compose(text), files: queueFiles(files) }, options, true)
                  }}
                  onSchedule={(text, timestamp, files) =>
                    remote.enqueue({ text: compose(text), files: queueFiles(files), scheduledAt: timestamp }, options)
                  }
                />
              </div>
            </PromptInputFooter>
          </PromptInput>
          {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
          {canControl ? (
            <PromptInputTools>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {toggles
                  .filter((m) => modesInRow.includes(m.key) || (m.key === "search" && modesInRow.includes("browser")))
                  .map((m) => (
                    <ModeToggle
                      key={m.key}
                      icon={m.icon}
                      label={m.label}
                      description={m.description}
                      active={m.active}
                      onToggle={() => m.onChange(!m.active)}
                      iconOnly={modeLabelStyle === "icon"}
                    />
                  ))}
              </div>
              <div className="ml-auto mt-2 flex items-center gap-0.5">
                <ToolsPopoverView servers={mcpServers} selection={state.tools ?? null} onChange={remote.setTools} iconOnly={modeLabelStyle === "icon"} />
                <ContextMeterView messages={messages ?? NO_MESSAGES} live={live} limit={info?.limit?.context} turnRunning={busy} />
              </div>
            </PromptInputTools>
          ) : null}
        </div>
      </SlashPalette>
    </PromptInputProvider>
  )
}
