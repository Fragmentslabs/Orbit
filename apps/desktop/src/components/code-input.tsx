import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlignLeft, Bot, BrainCircuit, Eye, FileText, MousePointerClick, Network, PlusIcon, RefreshCw, Search, X } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { DelegationMenuItems } from "@/src/components/delegation-menu"
import { ModeMenuItems, type ModeToggleDef } from "@/src/components/mode-menu-items"
import { VisionConfigDialog } from "@/src/components/vision-config-dialog"
import { LoopConfigDialog } from "@/src/components/loop-config-dialog"
import { ModelPicker } from "@/src/components/model-picker"
import { ModeToggle } from "@/src/components/mode-toggle"
import { OrchestrationConfigDialog } from "@/src/components/orchestration-config-dialog"
import { PermissionModePicker } from "@/src/components/permission-mode-picker"
import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { QuickSettingsMenu } from "@/src/components/quick-settings-menu"
import { DraftInputBridge } from "@/src/components/draft-input-bridge"
import { ChatInputDraft } from "@/src/components/chat-input-draft"
import { clearInputDraft } from "@/src/stores/chat-draft"
import { QueueIndicator } from "@/src/components/queue-indicator"
import { ContextMeter } from "@/src/components/context-meter"
import { SendButtonGroup } from "@/src/components/send-button-group"
import { SlashPalette } from "@/src/components/slash-palette"
import { FilePalette } from "@/src/components/file-palette"
import { useReferenceCommands, useSlashActionCommands, type SlashCommand } from "@/src/lib/slash-commands"
import { FolderSelector } from "@/src/components/folder-selector"
import { useWorkspace } from "@/lib/workspace-context"
import { useBrainEnabled, useBrainPrefs, useCodeContext } from "@/src/stores/brain-prefs"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useReasoningPrefs } from "@/src/stores/reasoning-prefs"
import { useSessionStore } from "@/src/stores/session-store"
import { useSimpleMode, useSimplePrefs } from "@/src/stores/simple-prefs"
import { useSkillsStore } from "@/src/stores/skills-store"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import type { ChatStatus, FilePart, PermissionMode, SendMessageOptions } from "@shared/chat"
import { toFileParts } from "@/src/lib/message-utils"
import { resolveSlashAction } from "@/src/lib/slash-actions"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function saveRecentFolders(folders: string[]) {
  localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
}

export function CodeInput({ onSubmit, status, onStop, hasMessages, sessionId }: {
  onSubmit: (text: string, options: SendMessageOptions, directory: string, extraDirectories: string[], files?: FilePart[]) => void
  status?: ChatStatus
  onStop?: () => void
  hasMessages?: boolean
  /** Sessão ativa — o toggle Brain é por chat (undefined = chat novo) */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const [plan, setPlan] = useState(false)
  const [search, setSearch] = useState(false)
  const [subagents, setSubagents] = useState(false)
  const [orchestra, setOrchestra] = useState(false)
  const [loop, setLoop] = useState(false)
  const { mode } = useWorkspace()
  // Orquestração é exclusiva do modo code
  useEffect(() => { if (mode === "chat") setOrchestra(false) }, [mode])
  const [configOpen, setConfigOpen] = useState(false)
  const [loopConfigOpen, setLoopConfigOpen] = useState(false)
  const simple = useSimpleMode(sessionId)
  const setSimple = useSimplePrefs((s) => s.setEnabled)
  const brain = useBrainEnabled(sessionId)
  const setBrainEnabled = useBrainPrefs((s) => s.setEnabled)
  const brainContext = useCodeContext()
  const permissionMode = usePermissionPrefs((s) => s.mode)
  const setPermissionMode = usePermissionPrefs((s) => s.setMode)
  const { folders, setFolders } = useWorkspace()

  // Skills de projeto (.orbit/skills) acompanham a pasta principal ativa
  useEffect(() => {
    void useSkillsStore.getState().refresh(folders[0])
  }, [folders])
  const selected = useSessionModel(sessionId)
  const catalog = useProviderStore((s) => s.catalog)
  const model = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined
  const { enabled, variantId, update } = useReasoningPrefs(selected?.providerId, selected?.modelId)
  const thinking = enabled || !!model?.reasoningAlwaysOn
  const busy = status === "submitted" || status === "streaming" || status === "cancelling"
  const openSettings = useSettingsUi((s) => s.openSettings)
  const enqueueForSend = useMessageQueueStore((s) => s.enqueueForSend)
  const enqueueScheduled = useMessageQueueStore((s) => s.enqueueScheduled)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const createSession = useSessionStore((s) => s.createSession)
  const openChatTab = usePanelStore((s) => s.openChatTab)
  const sessionDir = useSessionStore((s) => sessionId ? s.sessions.find(x => x.id === sessionId)?.directory : undefined)
  const visionModel = useProviderStore((s) => s.visionModel)
  const setVisionModel = useProviderStore((s) => s.setVisionModel)
  const workerModel = useProviderStore((s) => s.workerModel)
  const visionConfigOpen = useProviderStore((s) => s.visionConfigOpen)
  const setVisionConfigOpen = useProviderStore((s) => s.setVisionConfigOpen)
  const modesInRow = useAppearanceStore((s) => s.modesInRow)
  const modeLabelStyle = useAppearanceStore((s) => s.modeLabelStyle)
  const referenceCommands = useReferenceCommands()
  const actionCommands = useSlashActionCommands("code")

  const buildOptions = useCallback((): SendMessageOptions => ({
    plan,
    research: search,
    simple,
    brain,
    brainContext: brainContext === "all" ? true : brainContext === "memory" ? brain : false,
    permissionMode,
    reasoning: { enabled: thinking, variantId },
    subagents,
    orchestrate: orchestra && mode === "code" ? {} : undefined,
    loop,
  }), [plan, search, simple, brain, brainContext, permissionMode, thinking, variantId, subagents, orchestra, loop])

  const getDirs = useCallback(() => {
    const [directory, ...extraDirectories] = folders
    return { directory, extraDirectories }
  }, [folders])
  const selections = usePanelStore((s) => s.selections)
  const removeSelection = usePanelStore((s) => s.removeSelection)

  const modeToggleItems = useMemo<ModeToggleDef[]>(() => [
    { icon: Search, label: t("input.modes.search.label"), active: search, onChange: (v: boolean) => setSearch(v) },
    { icon: FileText, label: t("codeInput.modes.plan.label"), active: plan, onChange: (v: boolean) => setPlan(v) },
    { icon: AlignLeft, label: t("input.modes.simple.label"), active: simple, onChange: (v: boolean) => setSimple(sessionId, v) },
    { icon: BrainCircuit, label: t("input.modes.brain.label"), active: brain, onChange: (v: boolean) => setBrainEnabled(sessionId, v) },
    {
      icon: Eye,
      label: t("input.modes.vision.label"),
      active: !!visionModel,
      onChange: (v: boolean) => {
        if (v && !visionModel) setVisionConfigOpen(true) // ligar sem modelo → primeira configuração
        else if (!v) setVisionModel(null)
      },
      onConfig: () => setVisionConfigOpen(true),
    },
  ], [search, plan, simple, brain, visionModel, sessionId, setBrainEnabled, setSimple, setVisionModel, setVisionConfigOpen, t])

  const handleSubmit = useCallback((message: { text?: string; files?: { mediaType?: string; filename?: string; url?: string }[] }) => {
    const files = toFileParts(message.files ?? [])
    const resolved = message.text ? resolveSlashAction(message.text, "code") : null
    if (resolved?.action.kind === "init" && !busy) {
      const dir = folders[0]
      if (dir) {
        const force = resolved.input.includes("--force") || resolved.action.command === "/init-force"
        createSession("code", { directory: dir, extraDirectories: folders.slice(1) }).then((session) => {
          const text = force ? "/init --force" : "/init"
          sendMessage("code", text, { options: { initMode: true }, sessionId: session.id, directory: dir, extraDirectories: folders.slice(1) })
        })
      }
      return
    }
    const resolveText = (raw: string) => {
      const r = resolveSlashAction(raw, "code")
      return r?.prompt ?? raw
    }
    if (busy) {
      const text = message.text?.trim()
      if (!text) {
        onStop?.()
      } else if (sessionId && folders.length > 0) {
        const { directory, extraDirectories } = getDirs()
        enqueueForSend(sessionId, resolveText(text), buildOptions(), mode, { directory, extraDirectories, files })
        clearInputDraft(sessionId)
      }
      return
    }
    let text = message.text?.trim()
    if (!text || folders.length === 0) return
    text = resolveText(text)
    saveRecentFolders(folders)
    const [directory, ...extraDirectories] = folders
    const currentSelections = selections
    if (currentSelections.length > 0) {
      text += `\n\n${currentSelections
        .map(
          (sel) =>
            `[Elemento selecionado no browser do painel — <${sel.tag}> em ${sel.url}]\nselector: ${sel.selector}\ntexto: ${sel.text || "(sem texto)"}\nhtml: ${sel.html}`,
        )
        .join("\n\n")}`
      usePanelStore.getState().clearSelections()
    }
    // A mensagem foi enviada: o rascunho da sessão (se existia de uma troca
    // anterior) não pode mais voltar ao input ao reabrir o chat.
    if (sessionId) clearInputDraft(sessionId)
    return onSubmit(
      text,
      buildOptions(),
      directory,
      extraDirectories,
      files.length > 0 ? files : undefined,
    )
  }, [busy, folders, sessionId, onStop, selections, getDirs, buildOptions, onSubmit, mode, enqueueForSend, sendMessage, createSession])

  const slashCommands = useMemo<SlashCommand[]>(() => {
    const toggle = (fn: () => void) => ({ setText }: { setText: (t: string) => void }) => {
      fn()
      setText("")
    }
    const permission = (id: PermissionMode, label: string, description: string): SlashCommand => ({
      id: `perm-${id}`,
      label: t("codeInput.slash.permissionLabel", { label }),
      description,
      keywords: ["permissao", "autonomia", id],
      group: "Modos",
      active: permissionMode === id,
      run: toggle(() => setPermissionMode(id)),
    })
    return [
      { id: "pesquisa", label: t("input.modes.search.label"), description: t("codeInput.slash.searchDescription"), keywords: ["web", "search"], group: "Modos" as const, active: search, run: toggle(() => setSearch((v) => !v)) },
      { id: "plano", label: t("codeInput.modes.plan.label"), description: t("codeInput.slash.planDescription"), keywords: ["plan", "leitura"], group: "Modos" as const, active: plan, run: toggle(() => setPlan((v) => !v)) },
      { id: "simples", label: t("input.modes.simple.label"), description: t("input.slash.simpleDescription"), keywords: ["texto", "plain"], group: "Modos" as const, active: simple, run: toggle(() => setSimple(sessionId, !simple)) },
      { id: "brain", label: t("input.slash.brainLabel"), description: t("codeInput.slash.brainDescription"), keywords: ["memoria", "brain"], group: "Modos" as const, active: brain, run: toggle(() => setBrainEnabled(sessionId, !brain)) },
      { id: "subagents", label: t("codeInput.slash.subagentsLabel"), description: t("codeInput.slash.subagentsDescription"), keywords: ["worker", "delegar"], group: "Modos" as const, active: subagents, run: toggle(() => setSubagents((v) => !v)) },
      ...(mode === "code" ? [{ id: "orchestra", label: t("codeInput.slash.orchestraLabel"), description: t("codeInput.slash.orchestraDescription"), keywords: ["workers", "plano"], group: "Modos" as const, active: orchestra, run: toggle(() => setOrchestra((v) => !v)) }] : []),
      permission("ask", t("codeInput.slash.permAsk"), t("codeInput.slash.permAskDescription")),
      permission("approve", t("codeInput.slash.permApprove"), t("codeInput.slash.permApproveDescription")),
      permission("full", t("codeInput.slash.permFull"), t("codeInput.slash.permFullDescription")),
      ...actionCommands,
      ...referenceCommands,
      { id: "nova-sessao", label: t("codeInput.slash.newSession"), description: t("codeInput.slash.newSessionDescription"), keywords: ["clear", "limpar", "novo"], group: "Ações" as const, run: toggle(() => void useSessionStore.getState().selectSession(mode, null)) },
      { id: "create-skill", label: t("codeInput.slash.createSkill"), description: t("codeInput.slash.createSkillDescription"), keywords: ["skill", "criar", "aprender"], group: "Skills" as const, run: ({ setText }) => setText("/create-skill ") },
      { id: "document", label: t("codeInput.slash.documentApp"), description: t("codeInput.slash.documentAppDescription"), keywords: ["docs", "documentacao", "screenshot"], group: "Ações" as const, run: ({ setText }) => setText("/document ") },
      { id: "settings", label: t("input.slash.settings"), description: t("input.slash.settingsDescription"), keywords: ["settings", "config"], group: "Ações" as const, run: toggle(() => openSettings()) },
    ]
  }, [search, plan, simple, brain, subagents, orchestra, permissionMode, sessionId, setBrainEnabled, setSimple, setPermissionMode, actionCommands, referenceCommands, mode, openSettings, t])

  return (
    <PromptInputProvider>
      <FilePalette directory={sessionDir ?? folders[0]}>
      <SlashPalette commands={slashCommands}>
      <DraftInputBridge sessionId={sessionId} />
      <ChatInputDraft sessionId={sessionId} />
      <div className="w-full max-w-2xl mx-auto pb-4 @container">
        {!hasMessages && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
            <FolderSelector folders={folders} onFoldersChange={setFolders} />
          </div>
        )}
        <PromptInputAttachments className="!w-auto !p-0 mb-2">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        {/* Elementos selecionados no browser do painel (modo seleção) */}
        {selections.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
            {selections.map((sel) => (
              <span
                key={sel.id}
                title={`${sel.selector}\n"${sel.text}"`}
                className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400"
              >
                <MousePointerClick className="size-3" />
                {"<"}{sel.tag}{">"} {sel.text ? `"${sel.text.slice(0, 24)}${sel.text.length > 24 ? "…" : ""}"` : t("codeInput.selected")}
                <button
                  type="button"
                  onClick={() => removeSelection(sel.id)}
                  className="ml-0.5 rounded-sm hover:bg-emerald-500/20"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <QueueIndicator sessionId={sessionId} />
        <PromptInput
          multiple
          onSubmit={handleSubmit}
          className="rounded-xl border-2 border-sidebar-border [&>div]:!rounded-[calc(var(--radius-xl)-2px)] [&>div]:!border-none [&>div]:!bg-transparent"
        >
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={folders.length === 0 ? t("codeInput.placeholderNoFolder") : t("codeInput.placeholder")}
              className="px-3 text-base md:text-base"
            />
          </PromptInputBody>
          <PromptInputFooter>
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground">
                  <PlusIcon className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56 p-1.5">
                  <ModeMenuItems items={modeToggleItems} />
                  <DropdownMenuSeparator />
                  <DelegationMenuItems
                    subagents={subagents}
                    orchestra={orchestra}
                    loop={loop}
                    onSubagentsChange={(v) => {
                      setSubagents(v)
                      if (v) {
                        setOrchestra(false)
                        // Primeira ativação sem worker configurado → abre a configuração
                        if (!workerModel) setConfigOpen(true)
                      }
                    }}
                    onOrchestraChange={(v) => {
                      setOrchestra(v)
                      if (v) {
                        setSubagents(false)
                        // Primeira ativação sem worker configurado → abre a configuração
                        if (!workerModel) setConfigOpen(true)
                      }
                    }}
                    onLoopChange={setLoop}
                    onOpenConfig={() => setConfigOpen(true)}
                    onOpenLoopConfig={() => setLoopConfigOpen(true)}
                    mode={mode}
                  />
                  <DropdownMenuSeparator />
                  <PromptInputActionAddAttachments label={t("input.attachFiles")} />
                </DropdownMenuContent>
              </DropdownMenu>
              <QuickSettingsMenu sessionId={sessionId} showPermission />
              <div className="hidden @md:block">
                <PermissionModePicker />
              </div>
            </div>
            <div className="flex items-center gap-1">
              <div className="hidden @xl:flex items-center gap-1">
                {model?.variants && model.variants.length > 0 && (
                  <ReasoningPicker
                    variants={model.variants}
                    enabled={thinking}
                    canDisable={!model.reasoningAlwaysOn}
                    selected={variantId}
                    onSelect={(id) => update({ enabled: id != null, variantId: id ?? undefined })}
                  />
                )}
                <ModelPicker sessionId={sessionId} />
              </div>
              <SendButtonGroup
                busy={busy}
                cancelling={status === "cancelling"}
                disabled={folders.length === 0}
                onStop={() => onStop?.()}
                onQueue={(text) => {
                  if (!sessionId) return
                  const { directory, extraDirectories } = getDirs()
                  enqueueForSend(sessionId, text, buildOptions(), mode, { directory, extraDirectories })
                }}
                onStopAndSend={(text) => {
                  onStop?.()
                  if (!sessionId) return
                  const { directory, extraDirectories } = getDirs()
                  enqueueForSend(sessionId, text, buildOptions(), mode, { directory, extraDirectories })
                }}
                onSchedule={(text, timestamp) => {
                  if (!sessionId) return
                  const { directory, extraDirectories } = getDirs()
                  enqueueScheduled(sessionId, text, buildOptions(), mode, timestamp, { directory, extraDirectories })
                }}
                onSendToSidePanel={async (text) => {
                  const { directory, extraDirectories } = getDirs()
                  // Novo chat na mesma pasta da sessão atual (se ela estiver em uma)
                  const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
                  const newSession = await createSession(mode, { setActive: false, directory, extraDirectories, folderId: current?.folderId ?? null })
                  await sendMessage(mode, text, { options: buildOptions(), sessionId: newSession.id, directory, extraDirectories })
                  openChatTab(newSession.id, newSession.title)
                }}
              />
            </div>
          </PromptInputFooter>
        </PromptInput>
      <PromptInputTools>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {modesInRow.includes("search") && (
            <ModeToggle
              icon={Search}
              label={t("input.modes.search.label")}
              description={t("codeInput.modes.search.description")}
              active={search}
              onToggle={() => setSearch((v) => !v)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("plan") && (
            <ModeToggle
              icon={FileText}
              label={t("codeInput.modes.plan.label")}
              description={t("codeInput.modes.plan.description")}
              active={plan}
              onToggle={() => setPlan((v) => !v)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("simple") && (
            <ModeToggle
              icon={AlignLeft}
              label={t("input.modes.simple.label")}
              description={t("codeInput.modes.simple.description")}
              active={simple}
              onToggle={() => setSimple(sessionId, !simple)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("brain") && (
            <ModeToggle
              icon={BrainCircuit}
              label={t("input.modes.brain.label")}
              description={t("codeInput.modes.brain.description")}
              active={brain}
              onToggle={() => setBrainEnabled(sessionId, !brain)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("subagents") && (
            <ModeToggle
              icon={Bot}
              label={t("codeInput.modes.subagents.label")}
              description={t("codeInput.modes.subagents.description")}
              active={subagents}
              onToggle={() => {
                const next = !subagents
                setSubagents(next)
                if (next) {
                  setOrchestra(false)
                  // Primeira ativação sem worker configurado → abre a configuração
                  if (!workerModel) setConfigOpen(true)
                }
              }}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {mode === "code" && modesInRow.includes("orchestra") && (
            <ModeToggle
              icon={Network}
              label={t("codeInput.modes.orchestra.label")}
              description={t("codeInput.modes.orchestra.description")}
              active={orchestra}
              onToggle={() => {
                const next = !orchestra
                setOrchestra(next)
                if (next) {
                  setSubagents(false)
                  // Primeira ativação sem worker configurado → abre a configuração
                  if (!workerModel) setConfigOpen(true)
                }
              }}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("loop") && (
            <ModeToggle
              icon={RefreshCw}
              label={t("codeInput.modes.loop.label")}
              description={t("codeInput.modes.loop.description")}
              active={loop}
              onToggle={() => setLoop((v) => !v)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("vision") && (
            <ModeToggle
              icon={Eye}
              label={t("input.modes.vision.label")}
              description={t("input.modes.vision.description")}
              active={!!visionModel}
              onToggle={() => {
                if (visionModel) setVisionModel(null)
                else setVisionConfigOpen(true)
              }}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
        </div>
        <div className="ml-auto mt-2">
          <ContextMeter sessionId={sessionId} />
        </div>
      </PromptInputTools>
        <OrchestrationConfigDialog open={configOpen} onOpenChange={setConfigOpen} />
        <LoopConfigDialog open={loopConfigOpen} onOpenChange={setLoopConfigOpen} />
        <VisionConfigDialog open={visionConfigOpen} onOpenChange={setVisionConfigOpen} />
      </div>
      </SlashPalette>
      </FilePalette>
    </PromptInputProvider>
  )
}
