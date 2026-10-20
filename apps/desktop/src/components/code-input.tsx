import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlignLeft, Bot, BrainCircuit, Clapperboard, Eye, FileText, MousePointerClick, Network, PlusIcon, Quote, RefreshCw, Search, X } from "lucide-react"
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
import { OrchestrationConfigDialog, type DelegationConfigKind } from "@/src/components/orchestration-config-dialog"
import { PermissionModePicker } from "@/src/components/permission-mode-picker"
import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { QuickSettingsMenu } from "@/src/components/quick-settings-menu"
import { DraftInputBridge } from "@/src/components/draft-input-bridge"
import { ChatInputDraft } from "@/src/components/chat-input-draft"
import { ReplyBar } from "@/src/components/reply-bar"
import { withReplyPrefix } from "@/src/stores/message-reply"
import { DictationButton } from "@/src/components/dictation-button"
import { VoiceCallButton, VoiceCallPanel, useVoiceCallControl } from "@/src/components/voice-call"
import { PendingAttachmentSync } from "@/src/components/pending-attachment-sync"
import { clearInputDraft } from "@/src/stores/chat-draft"
import { QueueIndicator } from "@/src/components/queue-indicator"
import { ContextMeter } from "@/src/components/context-meter"
import { SendButtonGroup } from "@/src/components/send-button-group"
import { SlashPalette } from "@/src/components/slash-palette"
import { ReferencePalette } from "@/src/components/reference-palette"
import { useSlashActionCommands, type SlashCommand } from "@/src/lib/slash-commands"
import { FolderSelector } from "@/src/components/folder-selector"
import { useWorkspace } from "@/lib/workspace-context"
import { useBrainEnabled, useBrainPrefs, useCodeContext } from "@/src/stores/brain-prefs"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { useModeActive, useModeOverrides } from "@/src/stores/mode-overrides"
import { usePanelStore } from "@/src/stores/panel-store"
import { quoteChipLabel, quoteChipTitle, quotesToFileParts } from "@/src/lib/document-quote"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useProviderStore, useNoProviderConnected } from "@/src/stores/provider-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useReasoningPrefs } from "@/src/stores/reasoning-prefs"
import { usePromptSuggestion } from "@/src/stores/prompt-suggestion"
import { useSessionStore } from "@/src/stores/session-store"
import { useSimpleMode, useSimplePrefs } from "@/src/stores/simple-prefs"
import { useSkillsStore } from "@/src/stores/skills-store"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import type { ChatStatus, FilePart, PermissionMode, SendMessageOptions } from "@shared/chat"
import { BROWSER_SELECTION_MIME, closestVariant } from "@shared/chat"
import { toFileParts } from "@/src/lib/message-utils"
import { resolveSlashAction } from "@/src/lib/slash-actions"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function saveRecentFolders(folders: string[]) {
  localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
}

// Aviso da primeira vez (workers): o modal de configuração só abre na 1ª
// ativação do modo agente sem worker configurado. "Usar o modelo principal"
// é uma configuração válida (fallback para o modelo do chat) — depois do
// aviso, não reabre mais, nem em chat novo (persistido).
const WORKER_CONFIG_PROMPTED_KEY = "orbit-worker-config-prompted"

function workerConfigPrompted() {
  return localStorage.getItem(WORKER_CONFIG_PROMPTED_KEY) === "1"
}

function markWorkerConfigPrompted() {
  localStorage.setItem(WORKER_CONFIG_PROMPTED_KEY, "1")
}

export function CodeInput({ onSubmit, status, onStop, hasMessages, sessionId, onProviderBlocked, showFolders = true }: {
  onSubmit: (text: string, options: SendMessageOptions, directory: string, extraDirectories: string[], files?: FilePart[]) => void
  status?: ChatStatus
  onStop?: () => void
  hasMessages?: boolean
  /** Sessão ativa — o toggle Brain é por chat (undefined = chat novo) */
  sessionId?: string
  /** Sem provedor configurado e o usuário tentou enviar — quem renderiza o card decide como reagir */
  onProviderBlocked?: () => void
  /** Mostra o seletor de pastas/repositórios acima do input (some em visões como a tela cheia do browser) */
  showFolders?: boolean
}) {
  const { t } = useTranslation()
  // Chave da mensagem respondida: o chat de código não tem rascunho por
  // painel, então é a sessão (ou "draft" no chat novo).
  const replyKey = sessionId ?? "draft"
  const codeActiveModes = useModelModePrefs((s) => s.codeActiveModes)
  const plan = useModeActive("plan", sessionId, codeActiveModes.plan)
  const search = useModeActive("search", sessionId, codeActiveModes.search)
  const subagents = useModeActive("subagents", sessionId, codeActiveModes.subagents)
  // Worker (subchat de uma orquestracao) nunca orquestra: seria recursao, e o
  // engine ja bloqueia isso do lado do main (allowDelegation/orchestrate). O
  // toggle some da UI para o estado nao mentir sobre o que vai acontecer.
  const isWorker = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.orchestration?.role === "worker",
  )
  const orchestra =
    useModeActive("orchestra", sessionId, codeActiveModes.orchestra) && !isWorker
  const setModeActive = useModeOverrides((s) => s.setMode)
  const [loop, setLoop] = useState(false)
  const { mode } = useWorkspace()
  // Orquestração é exclusiva do modo code, e nunca dentro de um worker
  useEffect(() => {
    if (mode === "chat" || isWorker) setModeActive("orchestra", sessionId, false)
  }, [mode, isWorker, sessionId, setModeActive])
  const [configKind, setConfigKind] = useState<DelegationConfigKind | null>(null)
  const [loopConfigOpen, setLoopConfigOpen] = useState(false)
  // O menu "+" é controlado para poder FECHAR quando a engrenagem abre um dos
  // modais de configuração: o popup do menu vive em z-[999], acima dos modais
  // (z-[80]) de propósito, e a engrenagem corta a propagação do clique — sem
  // fechar na mão, ele fica aberto por cima do formulário.
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const simple = useSimpleMode(sessionId, codeActiveModes.simple)
  const setSimple = useSimplePrefs((s) => s.setEnabled)
  const brain = useBrainEnabled(sessionId, codeActiveModes.brain)
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
  const { enabled, variantId: savedVariant, update } = useReasoningPrefs(selected?.providerId, selected?.modelId)
  const suggestion = usePromptSuggestion(sessionId)
  // Nível salvo que este modelo não oferece (ex: "medium" onde só há
  // low/high/max) vira o vizinho mais próximo — o mesmo que o engine envia.
  const variantId = closestVariant(model?.variants?.map((v) => v.id) ?? [], savedVariant) ?? savedVariant
  // Thinking: o chip das preferências define o default; reasoning do modelo e
  // modelos com reasoningAlwaysOn continuam valendo como antes
  const thinking = codeActiveModes.thinking || enabled || !!model?.reasoningAlwaysOn
  const busy = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
  // Pré-configuração (sem provedor): o envio é bloqueado via onSubmitCapture —
  // em CAPTURE, antes do handleSubmit do PromptInput limpar o input — para o
  // texto do usuário não se perder; onProviderBlocked mostra o card explicativo
  const noProvider = useNoProviderConnected()
  const openSettings = useSettingsUi((s) => s.openSettings)
  const enqueueForSend = useMessageQueueStore((s) => s.enqueueForSend)
  const enqueueScheduled = useMessageQueueStore((s) => s.enqueueScheduled)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const createSession = useSessionStore((s) => s.createSession)
  const openChatTab = usePanelStore((s) => s.openChatTab)
  const sessionDir = useSessionStore((s) => sessionId ? s.sessions.find(x => x.id === sessionId)?.directory : undefined)
  const visionModel = useProviderStore((s) => s.visionModel)
  const vision = useModeActive("vision", sessionId, codeActiveModes.vision)
  const setVisionConfigOpen = useProviderStore((s) => s.setVisionConfigOpen)
  const visionConfigOpen = useProviderStore((s) => s.visionConfigOpen)
  const workerModel = useProviderStore((s) => s.workerModel)
  // Aviso da primeira vez: só abre na 1ª ativação do modo agente sem worker
  // configurado; depois disso o toggle só liga/desliga (padrão = modelo principal)
  const maybePromptWorkerConfig = useCallback((kind: DelegationConfigKind) => {
    if (workerModel || workerConfigPrompted()) return
    markWorkerConfigPrompted()
    setConfigKind(kind)
  }, [workerModel])
  const modesInRow = useAppearanceStore((s) => s.modesInRow)
  const modeLabelStyle = useAppearanceStore((s) => s.modeLabelStyle)
  const actionCommands = useSlashActionCommands("code")

  const buildOptions = useCallback((): SendMessageOptions => ({
    plan,
    research: search,
    simple,
    brain,
    brainContext: brainContext === "all" ? true : brainContext === "memory" ? brain : false,
    permissionMode,
    // Modo vindo do seletor: trocar no meio da resposta vale na hora.
    followGlobalPermission: true,
    reasoning: { enabled: thinking, variantId },
    subagents,
    orchestrate: orchestra && mode === "code" ? {} : undefined,
    // Na orquestra o Loop não vale (quem revisa é o orquestrador)
    loop: orchestra && mode === "code" ? undefined : loop,
  }), [plan, search, simple, brain, brainContext, permissionMode, thinking, variantId, subagents, orchestra, loop, mode])

  const getDirs = useCallback(() => {
    const [directory, ...extraDirectories] = folders
    return { directory, extraDirectories }
  }, [folders])
  /** Turno do modo chamada: mesmo caminho do Enter (fila quando ocupado), com
   *  `voiceCall` para o agente responder curto e falado. */
  const submitVoice = useCallback(
    (text: string): boolean => {
      if (noProvider) {
        onProviderBlocked?.()
        return false
      }
      if (folders.length === 0) return false
      const options = { ...buildOptions(), voiceCall: true }
      const { directory, extraDirectories } = getDirs()
      if (busy) {
        if (!sessionId) return false
        enqueueForSend(sessionId, text, options, mode, { directory, extraDirectories, files: [] })
        return true
      }
      void onSubmit(text, options, directory, extraDirectories)
      return true
    },
    [noProvider, onProviderBlocked, folders.length, buildOptions, getDirs, busy, sessionId, enqueueForSend, mode, onSubmit],
  )
  const voiceCall = useVoiceCallControl({ sessionId, submit: submitVoice })
  const selections = usePanelStore((s) => s.selections)
  const quotes = usePanelStore((s) => s.quotes)
  const removeQuote = usePanelStore((s) => s.removeQuote)
  const removeSelection = usePanelStore((s) => s.removeSelection)

  const modeToggleItems = useMemo<ModeToggleDef[]>(() => [
    { icon: Search, label: t("input.modes.search.label"), active: search, onChange: (v: boolean) => setModeActive("search", sessionId, v) },
    { icon: FileText, label: t("codeInput.modes.plan.label"), active: plan, onChange: (v: boolean) => setModeActive("plan", sessionId, v) },
    { icon: AlignLeft, label: t("input.modes.simple.label"), active: simple, onChange: (v: boolean) => setSimple(sessionId, v) },
    { icon: BrainCircuit, label: t("input.modes.brain.label"), active: brain, onChange: (v: boolean) => setBrainEnabled(sessionId, v) },
    {
      icon: Eye,
      label: t("input.modes.vision.label"),
      active: vision,
      onChange: (v: boolean) => {
        // Primeira ativação sem modelo configurado → abre a configuração;
        // depois disso o toggle só liga/desliga (a configuração fica guardada)
        if (v && !visionModel) setVisionConfigOpen(true)
        else setModeActive("vision", sessionId, v)
      },
      onConfig: () => setVisionConfigOpen(true),
    },
  ], [search, plan, simple, brain, vision, visionModel, sessionId, setBrainEnabled, setSimple, setModeActive, setVisionConfigOpen, t])

  const handleSubmit = useCallback((message: { text?: string; files?: { mediaType?: string; filename?: string; url?: string }[] }) => {
    // Editando um item da fila (lápis na fila): o Enter grava a edição no
    // MESMO item — a ordem da fila não muda — em vez de enfileirar outra.
    // Com o input vazio o Enter cancela a edição e o fluxo normal segue.
    const editingId = sessionId ? useMessageQueueStore.getState().editing[sessionId] : undefined
    const rawText = message.text?.trim()
    if (editingId && sessionId) {
      if (rawText) {
        const resolved = resolveSlashAction(rawText, "code")
        useMessageQueueStore.getState().update(sessionId, editingId, resolved?.prompt ?? rawText)
        useMessageQueueStore.getState().cancelEdit(sessionId)
        clearInputDraft(sessionId)
        return
      }
      useMessageQueueStore.getState().cancelEdit(sessionId)
    }
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
        enqueueForSend(sessionId, withReplyPrefix(replyKey, resolveText(text)), buildOptions(), mode, { directory, extraDirectories, files })
        clearInputDraft(sessionId)
      }
      return
    }
    let text = message.text?.trim()
    if (!text || folders.length === 0) return
    text = resolveText(text)
    saveRecentFolders(folders)
    const [directory, ...extraDirectories] = folders
    // Elementos selecionados no browser do painel (modo seleção): viram
    // anexos (chip/badge na bolha da mensagem, como PDFs). O detalhe
    // (selector/html/texto) vai serializado no data URL do MIME marcador e o
    // engine o converte em texto para o modelo — a bolha mostra só o chip.
    const currentSelections = selections
    if (currentSelections.length > 0) {
      files.push(
        ...currentSelections.map<FilePart>((sel) => {
          const payload = encodeURIComponent(
            JSON.stringify({
              tag: sel.tag,
              url: sel.url,
              selector: sel.selector,
              text: sel.text,
              html: sel.html,
            }),
          )
          const label = sel.text ? `"${sel.text.slice(0, 40)}${sel.text.length > 40 ? "…" : ""}"` : ""
          return {
            id: sel.id,
            type: "file",
            mime: BROWSER_SELECTION_MIME,
            filename: `<${sel.tag}>${label ? ` ${label}` : ""}`,
            url: `data:${BROWSER_SELECTION_MIME},${payload}`,
          }
        }),
      )
      usePanelStore.getState().clearSelections()
    }
    if (quotes.length > 0) {
      files.push(...quotesToFileParts(quotes))
      usePanelStore.getState().clearQuotes()
    }
    // A mensagem foi enviada: o rascunho da sessão (se existia de uma troca
    // anterior) não pode mais voltar ao input ao reabrir o chat.
    if (sessionId) clearInputDraft(sessionId)
    // A citação é prependada DEPOIS do comando "/" ser resolvido (ver chat-input)
    return onSubmit(
      withReplyPrefix(replyKey, text),
      buildOptions(),
      directory,
      extraDirectories,
      files.length > 0 ? files : undefined,
    )
  }, [busy, folders, sessionId, replyKey, onStop, selections, quotes, getDirs, buildOptions, onSubmit, mode, enqueueForSend, sendMessage, createSession])

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
      { id: "pesquisa", label: t("input.modes.search.label"), description: t("codeInput.slash.searchDescription"), keywords: ["web", "search"], group: "Modos" as const, active: search, run: toggle(() => setModeActive("search", sessionId, !search)) },
      { id: "plano", label: t("codeInput.modes.plan.label"), description: t("codeInput.slash.planDescription"), keywords: ["plan", "leitura"], group: "Modos" as const, active: plan, run: toggle(() => setModeActive("plan", sessionId, !plan)) },
      { id: "simples", label: t("input.modes.simple.label"), description: t("input.slash.simpleDescription"), keywords: ["texto", "plain"], group: "Modos" as const, active: simple, run: toggle(() => setSimple(sessionId, !simple)) },
      { id: "brain", label: t("input.slash.brainLabel"), description: t("codeInput.slash.brainDescription"), keywords: ["memoria", "brain"], group: "Modos" as const, active: brain, run: toggle(() => setBrainEnabled(sessionId, !brain)) },
      { id: "subagents", label: t("codeInput.slash.subagentsLabel"), description: t("codeInput.slash.subagentsDescription"), keywords: ["worker", "delegar"], group: "Modos" as const, active: subagents, run: toggle(() => {
        setModeActive("subagents", sessionId, !subagents)
        if (!subagents) maybePromptWorkerConfig("subagents")
      }) },
      ...(mode === "code" && !isWorker ? [{ id: "orchestra", label: t("codeInput.slash.orchestraLabel"), description: t("codeInput.slash.orchestraDescription"), keywords: ["workers", "plano"], group: "Modos" as const, active: orchestra, run: toggle(() => {
        setModeActive("orchestra", sessionId, !orchestra)
        if (!orchestra) {
          setLoop(false)
          maybePromptWorkerConfig("orchestra")
        }
      }) }] : []),
      permission("ask", t("codeInput.slash.permAsk"), t("codeInput.slash.permAskDescription")),
      permission("approve", t("codeInput.slash.permApprove"), t("codeInput.slash.permApproveDescription")),
      permission("full", t("codeInput.slash.permFull"), t("codeInput.slash.permFullDescription")),
      // Loop: na orquestra quem revisa é o orquestrador — o item aparece, mas
      // desabilitado (mesma regra do chip na linha do input).
      { id: "loop", label: t("codeInput.modes.loop.label"), description: orchestra ? t("delegation.loopOffInOrchestra") : t("codeInput.modes.loop.description"), keywords: ["loop", "iterar", "revisao"], group: "Modos" as const, active: loop && !orchestra, disabled: orchestra, run: toggle(() => setLoop((v) => !v)) },
      // Visão: primeira ativação sem modelo configurado abre a configuração.
      { id: "vision", label: t("input.modes.vision.label"), description: t("input.modes.vision.description"), keywords: ["visao", "imagem", "vision"], group: "Modos" as const, active: vision, run: toggle(() => {
        if (!vision && !visionModel) setVisionConfigOpen(true)
        else setModeActive("vision", sessionId, !vision)
      }) },
      ...actionCommands,
      { id: "nova-sessao", label: t("codeInput.slash.newSession"), description: t("codeInput.slash.newSessionDescription"), keywords: ["clear", "limpar", "novo"], group: "Ações" as const, run: toggle(() => void useSessionStore.getState().selectSession(mode, null)) },
      // Regra da paleta: o que ESCREVE texto no input aparece com o texto
      // literal (o que será enviado); o que só age na UI (modos, nova sessão,
      // settings) aparece com rótulo em prosa. Assim "/init" e "/document" são
      // iguais ao que o usuário digita, e nada mente sobre o que vai ser
      // enviado. As REFERÊNCIAS (skills, MCP, arquivos) ficam na paleta "@".
      { id: "create-skill", label: "/create-skill", description: t("codeInput.slash.createSkillDescription"), keywords: ["skill", "criar", "aprender"], group: "Ações" as const, run: ({ setText }) => setText("/create-skill ") },
      { id: "document", label: "/document", description: t("codeInput.slash.documentAppDescription"), keywords: ["docs", "documentacao", "screenshot"], group: "Ações" as const, run: ({ setText }) => setText("/document ") },
      { id: "settings", label: t("input.slash.settings"), description: t("input.slash.settingsDescription"), keywords: ["settings", "config"], group: "Ações" as const, run: toggle(() => openSettings()) },
    ]
  }, [search, plan, simple, brain, subagents, orchestra, isWorker, permissionMode, sessionId, setBrainEnabled, setSimple, setModeActive, setPermissionMode, actionCommands, mode, openSettings, maybePromptWorkerConfig, loop, vision, visionModel, setVisionConfigOpen, t])

  return (
    <PromptInputProvider>
      <ReferencePalette directory={sessionDir ?? folders[0]} className="mx-auto w-full max-w-2xl">
      <SlashPalette commands={slashCommands} className="mx-auto w-full max-w-2xl">
      <DraftInputBridge sessionId={sessionId} />
      <ChatInputDraft sessionId={sessionId} />
      <PendingAttachmentSync sessionId={sessionId} />
      <div className="w-full max-w-2xl mx-auto pb-4 @container">
        {!hasMessages && showFolders && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
            <FolderSelector folders={folders} onFoldersChange={setFolders} />
          </div>
        )}
        <PromptInputAttachments className="!w-auto !p-0 mb-2" leading={<ReplyBar replyKey={replyKey} />}>
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        {/* Trechos citados do visualizador de documento e instantes apontados
            na aba Motion */}
        {quotes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
            {quotes.map((q) => (
              <span
                key={q.id}
                title={quoteChipTitle(q)}
                className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
              >
                {q.kind === "motion" ? <Clapperboard className="size-3" /> : <Quote className="size-3" />}
                {quoteChipLabel(q)}
                <button
                  type="button"
                  onClick={() => removeQuote(q.id)}
                  className="ml-0.5 cursor-pointer rounded-sm hover:bg-primary/20"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
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
          onSubmitCapture={noProvider ? (e) => {
            e.preventDefault()
            e.stopPropagation()
            onProviderBlocked?.()
          } : undefined}
          onSubmit={handleSubmit}
          className="relative rounded-xl border-2 border-sidebar-border [&>div]:!rounded-[calc(var(--radius-xl)-2px)] [&>div]:!border-none [&>div]:!bg-transparent"
        >
          <PromptInputBody>
            {/* O microfone é ancorado na LINHA do textarea, e não no topo da
                caixa — a mesma posição do input do chat. */}
            <div className="relative w-full">
              {/* Canto SUPERIOR direito, no nível da primeira linha do texto —
                  a mesma posição do input do chat: absoluto para não empurrar o
                  conteúdo, com a folga à direita reservada no próprio textarea
                  (pr-10). */}
              <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5">
                <VoiceCallPanel control={voiceCall} />
                <DictationButton sessionId={sessionId} />
              </div>
              <PromptInputTextarea
                placeholder={folders.length === 0 ? t("codeInput.placeholderNoFolder") : t("codeInput.placeholder")}
                suggestion={suggestion}
                className="px-3 pr-10 text-base md:text-base"
              />
            </div>
          </PromptInputBody>
          <PromptInputFooter>
            <div className="flex items-center gap-1">
              <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
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
                      setModeActive("subagents", sessionId, v)
                      if (v) {
                        setModeActive("orchestra", sessionId, false)
                        // Aviso da primeira vez (só na 1ª ativação sem worker)
                        maybePromptWorkerConfig("subagents")
                      }
                    }}
                    onOrchestraChange={(v) => {
                      setModeActive("orchestra", sessionId, v)
                      if (v) {
                        setModeActive("subagents", sessionId, false)
                        setLoop(false)
                        // Aviso da primeira vez (só na 1ª ativação sem worker)
                        maybePromptWorkerConfig("orchestra")
                      }
                    }}
                    onLoopChange={setLoop}
                    onOpenConfig={(kind) => {
                      // Fecha o "+" antes de abrir o modal (ver comentário do
                      // estado): o popup do menu cobriria o formulário.
                      setAddMenuOpen(false)
                      setConfigKind(kind)
                    }}
                    onOpenLoopConfig={() => {
                      setAddMenuOpen(false)
                      setLoopConfigOpen(true)
                    }}
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
                emptySlot={voiceCall.inSlot ? <VoiceCallButton control={voiceCall} /> : undefined}
                emptySlotAlways={voiceCall.call.active}
                busy={busy}
                cancelling={status === "cancelling"}
                disabled={folders.length === 0}
                onStop={() => onStop?.()}
                onQueue={(text, files) => {
                  if (!sessionId) return
                  const { directory, extraDirectories } = getDirs()
                  enqueueForSend(sessionId, withReplyPrefix(replyKey, text), buildOptions(), mode, { directory, extraDirectories, files: toFileParts(files ?? []) })
                }}
                onStopAndSend={(text, files) => {
                  onStop?.()
                  if (!sessionId) return
                  const { directory, extraDirectories } = getDirs()
                  enqueueForSend(sessionId, withReplyPrefix(replyKey, text), buildOptions(), mode, { directory, extraDirectories, files: toFileParts(files ?? []) })
                }}
                onSchedule={(text, timestamp, files) => {
                  if (!sessionId) return
                  const { directory, extraDirectories } = getDirs()
                  enqueueScheduled(sessionId, withReplyPrefix(replyKey, text), buildOptions(), mode, timestamp, { directory, extraDirectories, files: toFileParts(files ?? []) })
                }}
                onSendToSidePanel={async (text, files) => {
                  const { directory, extraDirectories } = getDirs()
                  // Novo chat na mesma pasta da sessão atual (se ela estiver em uma)
                  const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
                  const newSession = await createSession(mode, { setActive: false, directory, extraDirectories, folderId: current?.folderId ?? null })
                  await sendMessage(mode, withReplyPrefix(replyKey, text), { options: buildOptions(), sessionId: newSession.id, directory, extraDirectories, files: toFileParts(files ?? []) })
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
              onToggle={() => setModeActive("search", sessionId, !search)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("plan") && (
            <ModeToggle
              icon={FileText}
              label={t("codeInput.modes.plan.label")}
              description={t("codeInput.modes.plan.description")}
              active={plan}
              onToggle={() => setModeActive("plan", sessionId, !plan)}
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
                setModeActive("subagents", sessionId, next)
                if (next) {
                  setModeActive("orchestra", sessionId, false)
                  // Aviso da primeira vez (só na 1ª ativação sem worker)
                  maybePromptWorkerConfig("subagents")
                }
              }}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {mode === "code" && !isWorker && modesInRow.includes("orchestra") && (
            <ModeToggle
              icon={Network}
              label={t("codeInput.modes.orchestra.label")}
              description={t("codeInput.modes.orchestra.description")}
              active={orchestra}
              onToggle={() => {
                const next = !orchestra
                setModeActive("orchestra", sessionId, next)
                if (next) {
                  setModeActive("subagents", sessionId, false)
                  setLoop(false)
                  // Aviso da primeira vez (só na 1ª ativação sem worker)
                  maybePromptWorkerConfig("orchestra")
                }
              }}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("loop") && (
            <ModeToggle
              icon={RefreshCw}
              label={t("codeInput.modes.loop.label")}
              description={orchestra ? t("delegation.loopOffInOrchestra") : t("codeInput.modes.loop.description")}
              active={loop && !orchestra}
              disabled={orchestra}
              onToggle={() => setLoop((v) => !v)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("vision") && (
            <ModeToggle
              icon={Eye}
              label={t("input.modes.vision.label")}
              description={t("input.modes.vision.description")}
              active={vision}
              onToggle={() => {
                if (vision) setModeActive("vision", sessionId, false)
                else if (visionModel) setModeActive("vision", sessionId, true)
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
        <OrchestrationConfigDialog kind={configKind} onOpenChange={(open) => { if (!open) setConfigKind(null) }} />
        <LoopConfigDialog open={loopConfigOpen} onOpenChange={setLoopConfigOpen} />
        <VisionConfigDialog open={visionConfigOpen} onOpenChange={setVisionConfigOpen} targetSession={sessionId} />
      </div>
      </SlashPalette>
      </ReferencePalette>
    </PromptInputProvider>
  )
}
