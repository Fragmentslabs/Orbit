import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Bell, BookOpen, Database, Globe, KeyRound, Monitor, Palette, Settings2, Shield, Trash2, Check, Plus, Wifi, WifiOff, RefreshCw, Server, Volume2, X, Pencil, Info, ChevronDown, Loader2 } from "lucide-react"
import type { CatalogProvider, ProviderProtocol } from "@shared/chat"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ModelSelectorLogo } from "@/src/components/ai/model-selector"
import { PreferencesPanel } from "@/src/components/preferences-panel"
import { DataPanel } from "@/src/components/data-panel"
import { HowToPanel } from "@/src/components/how-to-panel"
import { AppearancePanel } from "@/src/components/appearance-panel"
import { SystemPanel } from "@/src/components/system-panel"
import { VoicePanel } from "@/src/components/settings-voice-panel"
import { NotificationsPanel } from "@/src/components/notifications-panel"
import { AboutPanel } from "@/src/components/about-panel"
import { BrowserPanel } from "@/src/components/browser-panel"
import { ComputerPanel } from "@/src/components/computer-panel"
import { useProviderStore } from "@/src/stores/provider-store"
import { customProvidersApi, windowApi } from "@/src/lib/ipc"
import { isLocalEndpoint } from "@/src/lib/provider-endpoint"
import { cn } from "@/lib/utils"

import { useSettingsUi, type SettingsTab } from "@/src/stores/settings-ui"
import type { DetectResult } from "@/src/lib/ipc"

interface TabDef {
  id: SettingsTab
  label: string
  icon: typeof Shield
  description: string
  /** Recurso ainda em teste: ganha o selo "Beta" na lista e no título. */
  beta?: boolean
}

function useTabs(): TabDef[] {
  const { t } = useTranslation()
  const tabs: TabDef[] = [
    { id: "providers", label: t("settings.tabs.providers.label"), icon: KeyRound, description: t("settings.tabs.providers.description") },
    { id: "autonomy", label: t("settings.tabs.autonomy.label"), icon: Shield, description: t("settings.tabs.autonomy.description") },
    { id: "howto", label: t("settings.tabs.howto.label"), icon: BookOpen, description: t("settings.tabs.howto.description") },
    { id: "appearance", label: t("settings.tabs.appearance.label"), icon: Palette, description: t("settings.tabs.appearance.description") },
    { id: "notifications", label: t("settings.tabs.notifications.label"), icon: Bell, description: t("settings.tabs.notifications.description") },
    { id: "voice", label: t("settings.tabs.voice.label"), icon: Volume2, description: t("settings.tabs.voice.description"), beta: true },
    { id: "browser", label: t("settings.tabs.browser.label"), icon: Globe, description: t("settings.tabs.browser.description") },
    // Computador: a v1 só tem driver no macOS — nas outras plataformas a aba não aparece.
    { id: "computer", label: t("settings.tabs.computer.label"), icon: Monitor, description: t("settings.tabs.computer.description"), beta: true },
    // Sistema só tem o "Abrir com Orbit" do Explorer, que é exclusivo do
    // Windows: em macOS/Linux a aba nem aparece (ver `visibleTabs` abaixo).
    { id: "system", label: t("settings.tabs.system.label"), icon: Settings2, description: t("settings.tabs.system.description") },
    { id: "data", label: t("settings.tabs.data.label"), icon: Database, description: t("settings.tabs.data.description") },
    { id: "about", label: t("settings.tabs.about.label"), icon: Info, description: t("settings.tabs.about.description") },
  ]
  return tabs.filter(
    (tab) => (tab.id !== "system" || windowApi.platform === "win32") && (tab.id !== "computer" || windowApi.platform === "darwin"),
  )
}

/**
 * Enquanto o campo de chave está aberto, esta linha é a dona do foco.
 *
 * O campo perdia o foco sozinho no meio da digitação — e ninguém mais
 * recuperava: o `blur` ia para o `body` sem nenhuma interação do usuário e as
 * teclas seguintes caíam no vazio (não dava para cadastrar a chave pelo
 * seletor de modelos; o caminho pela sidebar às vezes escapava). Como não há
 * como saber quem rouba o foco de fora, o campo se defende: se o foco sair para
 * o vazio sem um `pointerdown` recente, ele volta — e registra quem levou, para
 * a próxima ocorrência dizer o nome do culpado.
 */
function useKeepFocusWhileEditing(active: boolean, containerRef: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    if (!active) return
    const input = containerRef.current?.querySelector("input")
    if (!input) return

    let lastPointerDown = 0
    const onPointerDown = () => {
      lastPointerDown = performance.now()
    }
    /** Um destino de foco de verdade (campo, botão, link, algo com tabindex) é
     *  navegação legítima — Tab, clique em outro campo. O que o campo recupera
     *  é o foco que "sumiu": `body`, um `div` do diálogo, nada. */
    const isMeaningfulTarget = (node: Element | null) =>
      !!node &&
      node !== document.body &&
      node.matches("input, textarea, select, button, a[href], [tabindex], [contenteditable=true]")

    /** Devolve o foco, se ele realmente escapou: clique do usuário e foco que foi
     *  para outro campo são movimentos legítimos e não se combatem. */
    const reclaim = () => {
      if (performance.now() - lastPointerDown < 400) return
      if (!input.isConnected || document.activeElement === input) return
      if (isMeaningfulTarget(document.activeElement)) return
      console.warn("[providers] campo de chave perdeu o foco sozinho; devolvendo", document.activeElement)
      input.focus()
    }
    // O foco indo para o vazio chega como `blur` — e nem sempre vem acompanhado
    // do `focusout` (o `blur` avisa primeiro); os dois entram, deduplicados,
    // porque o mesmo movimento gera os dois eventos.
    let lastFocusOut = 0
    const onFocusOut = () => {
      if (performance.now() - lastFocusOut < 50) return
      lastFocusOut = performance.now()
      reclaim()
      // O roubo pode chegar atrasado (rAF/timer de quem tirou o foco): confere
      // de novo depois, ainda respeitando o clique do usuário.
      requestAnimationFrame(reclaim)
      setTimeout(reclaim, 150)
    }

    // Foco inicial explícito em vez do `autoFocus` nativo: assim ele roda
    // depois do commit (o mesmo efeito reinstala a posse do campo quando a
    // linha remonta com o campo aberto).
    input.focus()
    input.addEventListener("blur", onFocusOut)
    input.addEventListener("focusout", onFocusOut)
    window.addEventListener("pointerdown", onPointerDown, true)
    // Janela voltando ao foco com o campo aberto: se o foco do documento não
    // está em nenhum campo, o usuário digitando aqui não escreveria em nada.
    window.addEventListener("focus", reclaim)
    return () => {
      input.removeEventListener("blur", onFocusOut)
      input.removeEventListener("focusout", onFocusOut)
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("focus", reclaim)
    }
  }, [active, containerRef])
}

const ProviderRow = memo(function ProviderRow({
  providerId,
  editing,
  draft,
  onEdit,
  onDraftChange,
}: {
  providerId: string
  /** Campo de chave aberto nesta linha */
  editing: boolean
  /** Texto já digitado desta linha (o estado vive no ProvidersTab — ver lá) */
  draft: string
  /* Callbacks levam o id (em vez de serem fechados sobre ele) para continuarem
     estáveis: com props estáveis, o `memo` evita re-renderizar as outras
     dezenas de linhas da lista a cada tecla digitada. */
  onEdit: (providerId: string, editing: boolean) => void
  onDraftChange: (providerId: string, value: string) => void
}) {
  const { t } = useTranslation()
  const provider = useProviderStore((s) => s.catalog[providerId])
  const connected = useProviderStore((s) => s.connectedProviders.includes(providerId))
  const setApiKey = useProviderStore((s) => s.setApiKey)
  const removeApiKey = useProviderStore((s) => s.removeApiKey)

  const [saving, setSaving] = useState(false)
  const keyFieldRef = useRef<HTMLDivElement>(null)
  const openField = editing && !connected
  useKeepFocusWhileEditing(openField, keyFieldRef)

  if (!provider) return null

  const save = async () => {
    if (!draft.trim()) return
    setSaving(true)
    await setApiKey(providerId, draft.trim())
    setSaving(false)
    onEdit(providerId, false)
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <ModelSelectorLogo provider={providerId} className="size-4" />
        <span className="flex-1 truncate text-sm font-medium">{provider.name}</span>
        {connected && (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <Check className="size-3" />
            {t("providers.connected")}
          </Badge>
        )}
        {connected ? (
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("providers.removeKey")}
            onClick={() => void removeApiKey(providerId)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : (
          !editing && (
            <Button size="sm" variant="outline" className="gap-1" onClick={() => onEdit(providerId, true)}>
              <KeyRound className="size-3.5" />
              {t("providers.addKey")}
            </Button>
          )
        )}
      </div>
      {openField && (
        <div ref={keyFieldRef} className="flex gap-2">
          <Input
            type="password"
            value={draft}
            placeholder={t("providers.apiKeyPlaceholder", { name: provider.name })}
            onChange={(e) => onDraftChange(providerId, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save()
              if (e.key === "Escape") onEdit(providerId, false)
            }}
          />
          <Button disabled={!draft.trim() || saving} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </div>
      )}
    </div>
  )
})

/** Modelo em edição no diálogo (o enabled é estado só da UI, não vai ao disco). */
interface ModelDraft {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  enabled: boolean
}

type KeyMode = "key" | "env" | "none"

function modelsFromProvider(provider: CatalogProvider | undefined): ModelDraft[] {
  if (!provider) return []
  return Object.values(provider.models).map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.limit?.context,
    maxTokens: model.limit?.output,
    reasoning: model.reasoning,
    enabled: true,
  }))
}

/** Precisa bater com defaultEnvName do main (custom-providers.ts). */
function defaultEnvName(providerId: string): string {
  const slug = providerId.replace(/^custom:/, "").toUpperCase().replace(/[^A-Z0-9_]/g, "_")
  return `CUSTOM_${slug}_KEY`
}

function keyModeOf(provider: CatalogProvider | undefined): KeyMode {
  const env = provider?.env[0]
  if (!env) return "none"
  return env === defaultEnvName(provider.id) ? "key" : "env"
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return slug || "provedor"
}

/**
 * Servidores locais conhecidos. O clique só preenche a URL e dispensa a chave:
 * o formulário continua editável, e o "Buscar modelos" segue sendo o passo que
 * confirma que o servidor está no ar e quais modelos ele tem. As duas primeiras
 * URLs são as mesmas dos seeds (`custom-providers.ts`), para o card criado à
 * mão e o detectado apontarem para o mesmo lugar.
 */
const LOCAL_PRESETS = [
  { id: "ollama", name: "Ollama", baseURL: "http://localhost:11434/v1" },
  { id: "lmstudio", name: "LM Studio", baseURL: "http://localhost:1234/v1" },
  { id: "vllm", name: "vLLM", baseURL: "http://localhost:8000/v1" },
  { id: "llamacpp", name: "llama.cpp", baseURL: "http://localhost:8080/v1" },
] as const

function CustomProviderCard({
  provider,
  onEdit,
  onRemove,
}: {
  provider: CatalogProvider
  onEdit: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const refreshProviderModels = useProviderStore((s) => s.refreshProviderModels)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")

  const count = Object.keys(provider.models).length
  // `env` com nome e `hasKey` falso = espera chave que ainda não existe.
  const missingKey = provider.env.length > 0 && provider.hasKey === false
  const local = isLocalEndpoint(provider.api)

  const refresh = async () => {
    setRefreshing(true)
    setError("")
    try {
      await refreshProviderModels(provider.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span
          className="shrink-0"
          title={local ? t("providers.local.groupLocal") : t("providers.local.groupRemote")}
        >
          {local ? (
            <Server className="size-4 text-muted-foreground" />
          ) : (
            <Globe className="size-4 text-muted-foreground" />
          )}
        </span>
        <span className="flex-1 truncate text-sm font-medium">{provider.name}</span>
        {count === 0 ? (
          <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
            {t("providers.local.noModels")}
          </Badge>
        ) : (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            {t("providers.local.models", { count })}
          </Badge>
        )}
        {missingKey && (
          <Badge variant="outline" className="gap-1 text-[10px] text-destructive">
            <KeyRound className="size-3" />
            {t("providers.local.noKey")}
          </Badge>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          title={t("providers.local.refresh")}
          disabled={refreshing || !provider.api}
          onClick={() => void refresh()}
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
        <Button size="icon-sm" variant="ghost" title={t("providers.local.edit")} onClick={onEdit}>
          <Pencil className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" title={t("providers.local.remove")} onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {provider.api && (
        <p className="truncate text-[11px] text-muted-foreground">
          {provider.api}
          {provider.protocol && provider.protocol !== "openai-completions" && (
            <span className="ml-2 text-muted-foreground/70">
              {provider.protocol === "anthropic-messages"
                ? t("providers.dialog.protocolAnthropic")
                : t("providers.dialog.protocolResponses")}
            </span>
          )}
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

function CustomProviderDialog({
  open,
  onOpenChange,
  editProvider,
  initialName = "",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editProvider?: CatalogProvider
  /** Nome sugerido ao criar (vem da busca da nuvem, ex.: o que foi digitado). */
  initialName?: string
}) {
  const { t } = useTranslation()
  const addCustomProvider = useProviderStore((s) => s.addCustomProvider)
  const updateCustomProvider = useProviderStore((s) => s.updateCustomProvider)

  const isEdit = !!editProvider

  const [name, setName] = useState("")
  const [baseURL, setBaseURL] = useState("")
  const [keyMode, setKeyMode] = useState<KeyMode>("key")
  const [apiKey, setApiKey] = useState("")
  const [keyEnv, setKeyEnv] = useState("")
  const [protocol, setProtocol] = useState<ProviderProtocol>("openai-completions")
  const [maxTokensField, setMaxTokensField] = useState<"max_tokens" | "max_completion_tokens">("max_tokens")
  const [thinking, setThinking] = useState<"auto" | "deepseek" | "none">("auto")
  const [models, setModels] = useState<ModelDraft[]>([])
  const [manualId, setManualId] = useState("")
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState("")
  const [advanced, setAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    const provider = editProvider
    setName(provider?.name ?? initialName)
    setBaseURL(provider?.api ?? "")
    setKeyMode(keyModeOf(provider))
    setApiKey("")
    setKeyEnv(provider && keyModeOf(provider) === "env" ? (provider.env[0] ?? "") : "")
    setProtocol(provider?.protocol ?? "openai-completions")
    setMaxTokensField(provider?.compat?.maxTokensField ?? "max_tokens")
    setThinking(provider?.compat?.thinkingFormat ?? "auto")
    setModels(modelsFromProvider(provider))
    setManualId("")
    setDiscovering(false)
    setDiscoverError("")
    setAdvanced(provider?.protocol !== undefined || provider?.compat !== undefined)
    setError("")
  }, [open, editProvider, initialName])

  const enabledModels = models.filter((model) => model.enabled)
  const keyRequired =
    keyMode === "key" &&
    !apiKey.trim() &&
    !(isEdit && editProvider?.hasKey && keyModeOf(editProvider) === "key")
  const envRequired = keyMode === "env" && !keyEnv.trim()
  const canSave =
    !!name.trim() && !!baseURL.trim() && enabledModels.length > 0 && !keyRequired && !envRequired && !saving

  const toggleModel = (id: string) =>
    setModels((current) =>
      current.map((model) => (model.id === id ? { ...model, enabled: !model.enabled } : model)),
    )

  const addManual = () => {
    const id = manualId.trim()
    if (!id) return
    setModels((current) =>
      current.some((model) => model.id === id)
        ? current
        : [...current, { id, enabled: true }],
    )
    setManualId("")
  }

  /** Preenche o cadastro a partir de um servidor local conhecido. */
  const applyPreset = (preset: (typeof LOCAL_PRESETS)[number]) => {
    setBaseURL(preset.baseURL)
    // Servidor local não pede chave: sem isto o "salvar" fica bloqueado
    // esperando uma credencial que não existe.
    setKeyMode("none")
    setProtocol("openai-completions")
    if (!name.trim()) setName(preset.name)
  }

  /**
   * Consulta o /models do servidor e marca tudo como disponível. Roda sem
   * gravar nada: o cadastro só é escrito no "salvar" (o resultado parcial não
   * vira um provedor fantasma).
   */
  const handleDiscover = async () => {
    if (!baseURL.trim()) return
    setDiscovering(true)
    setDiscoverError("")
    try {
      const found = await customProvidersApi.discover({
        baseURL: baseURL.trim(),
        ...(keyMode === "key" && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        protocol,
        // Em edição o provedor já pode ter a chave salva: sem isto o
        // "buscar modelos" tomaria 401 mesmo com a credencial gravada.
        ...(editProvider ? { providerId: editProvider.id } : {}),
      })
      setModels((current) => {
        const byId = new Map(current.map((model) => [model.id, model]))
        const next: ModelDraft[] = found.map((item) => {
          const existing = byId.get(item.id)
          return existing
            ? {
                ...existing,
                name: item.name ?? existing.name,
                contextWindow: item.contextWindow ?? existing.contextWindow,
                maxTokens: item.maxTokens ?? existing.maxTokens,
              }
            : {
                id: item.id,
                name: item.name,
                contextWindow: item.contextWindow,
                maxTokens: item.maxTokens,
                enabled: true,
              }
        })
        // Mantém o que foi adicionado à mão e não apareceu na listagem.
        for (const model of current) {
          if (!next.some((item) => item.id === model.id)) next.push(model)
        }
        return next
      })
    } catch (err) {
      setDiscoverError((err as Error).message)
    } finally {
      setDiscovering(false)
    }
  }

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError("")
    const payloadModels = enabledModels.map(({ id, name, contextWindow, maxTokens, reasoning }) => ({
      id,
      ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    }))
    const compat = {
      ...(maxTokensField === "max_completion_tokens" ? { maxTokensField } : {}),
      ...(thinking !== "auto" ? { thinkingFormat: thinking } : {}),
    }
    const authPayload = {
      ...(keyMode === "env" ? { keyEnv: keyEnv.trim() } : {}),
      ...(keyMode === "key" && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }
    try {
      if (isEdit && editProvider) {
        await updateCustomProvider(editProvider.id, {
          name: name.trim(),
          baseURL: baseURL.trim(),
          protocol,
          compat,
          models: payloadModels,
          ...authPayload,
          ...(keyMode === "none" ? { keyEnv: null } : {}),
        })
      } else {
        await addCustomProvider({
          id: slugify(name),
          name: name.trim(),
          baseURL: baseURL.trim(),
          protocol,
          compat,
          models: payloadModels,
          ...authPayload,
        })
      }
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{isEdit ? t("providers.dialog.editTitle") : t("providers.dialog.addTitle")}</DialogTitle>
          <DialogDescription className="text-xs">
            {t("providers.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
          {!isEdit && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t("providers.dialog.presets")}</label>
              <div className="flex flex-wrap gap-1">
                {LOCAL_PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    size="sm"
                    variant={baseURL.trim() === preset.baseURL ? "secondary" : "outline"}
                    onClick={() => applyPreset(preset)}
                  >
                    {preset.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">{t("providers.dialog.name")}</label>
            <Input value={name} placeholder={t("providers.dialog.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">{t("providers.dialog.baseUrl")}</label>
            <Input value={baseURL} placeholder={t("providers.dialog.baseUrlPlaceholder")} onChange={(e) => setBaseURL(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">{t("providers.dialog.auth")}</label>
            <select
              value={keyMode}
              onChange={(e) => setKeyMode(e.target.value as KeyMode)}
              className="h-8 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:border-ring"
            >
              <option value="key" className="bg-popover text-popover-foreground">{t("providers.dialog.authKey")}</option>
              <option value="env" className="bg-popover text-popover-foreground">{t("providers.dialog.authEnv")}</option>
              <option value="none" className="bg-popover text-popover-foreground">{t("providers.dialog.authNone")}</option>
            </select>
          </div>

          {keyMode === "key" && (
            <div className="flex flex-col gap-1">
              <Input
                type="password"
                value={apiKey}
                placeholder={isEdit ? t("providers.dialog.apiKeyPlaceholder") : t("providers.dialog.apiKey")}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">{t("providers.dialog.keyHint")}</p>
            </div>
          )}

          {keyMode === "env" && (
            <Input
              value={keyEnv}
              placeholder={t("providers.dialog.envNamePlaceholder")}
              onChange={(e) => setKeyEnv(e.target.value)}
            />
          )}

          <div className="flex flex-col gap-1.5 border-t pt-3">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium">{t("providers.dialog.models")}</label>
              <span className="text-[11px] text-muted-foreground">
                {t("providers.dialog.modelsSelected", { count: enabledModels.length })}
              </span>
              <div className="flex-1" />
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                disabled={!baseURL.trim() || discovering}
                onClick={() => void handleDiscover()}
              >
                {discovering ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                {discovering ? t("providers.dialog.discovering") : t("providers.dialog.discover")}
              </Button>
            </div>

            {models.length > 0 && (
              <div className="flex flex-col rounded-md border">
                {models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => toggleModel(model.id)}
                    className="flex items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/40"
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        model.enabled && "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      {model.enabled && <Check className="size-3" />}
                    </span>
                    <span className="flex-1 truncate text-xs">{model.name ?? model.id}</span>
                    {model.contextWindow ? (
                      <span className="text-[10px] text-muted-foreground">
                        {Math.round(model.contextWindow / 1024)}k ctx
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}

            {models.length === 0 && !discoverError && (
              <p className="text-[11px] text-muted-foreground">{t("providers.dialog.discoverHint")}</p>
            )}
            {models.length > 0 && enabledModels.length === 0 && (
              <p className="text-[11px] text-muted-foreground">{t("providers.dialog.modelsEmpty")}</p>
            )}
            {discoverError && (
              <p className="text-[11px] text-destructive">
                {t("providers.dialog.discoverError", { error: discoverError })}
              </p>
            )}

            <div className="flex gap-1.5">
              <Input
                value={manualId}
                placeholder={t("providers.dialog.manualPlaceholder")}
                className="h-7 text-xs"
                onChange={(e) => setManualId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addManual()
                  }
                }}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                disabled={!manualId.trim()}
                onClick={addManual}
              >
                <Plus className="size-3" />
                {t("providers.dialog.manualAdd")}
              </Button>
            </div>
          </div>

          <div className="border-t pt-2">
            <button
              type="button"
              className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setAdvanced((value) => !value)}
            >
              <ChevronDown className={cn("size-3 transition-transform", advanced && "rotate-180")} />
              {t("providers.dialog.advanced")}
            </button>

            {advanced && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">{t("providers.dialog.protocol")}</label>
                  <select
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value as ProviderProtocol)}
                    className="h-8 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:border-ring"
                  >
                    <option value="openai-completions" className="bg-popover text-popover-foreground">{t("providers.dialog.protocolOpenai")}</option>
                    <option value="openai-responses" className="bg-popover text-popover-foreground">{t("providers.dialog.protocolResponses")}</option>
                    <option value="anthropic-messages" className="bg-popover text-popover-foreground">{t("providers.dialog.protocolAnthropic")}</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">{t("providers.dialog.maxTokensField")}</label>
                  <select
                    value={maxTokensField}
                    onChange={(e) => setMaxTokensField(e.target.value as "max_tokens" | "max_completion_tokens")}
                    className="h-8 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:border-ring"
                  >
                    <option value="max_tokens" className="bg-popover text-popover-foreground">{t("providers.dialog.maxTokensDefault")}</option>
                    <option value="max_completion_tokens" className="bg-popover text-popover-foreground">{t("providers.dialog.maxTokensCompletion")}</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">{t("providers.dialog.thinking")}</label>
                  <select
                    value={thinking}
                    onChange={(e) => setThinking(e.target.value as "auto" | "deepseek" | "none")}
                    className="h-8 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:border-ring"
                  >
                    <option value="auto" className="bg-popover text-popover-foreground">{t("providers.dialog.thinkingAuto")}</option>
                    <option value="deepseek" className="bg-popover text-popover-foreground">{t("providers.dialog.thinkingDeepseek")}</option>
                    <option value="none" className="bg-popover text-popover-foreground">{t("providers.dialog.thinkingNone")}</option>
                  </select>
                </div>

                <p className="text-[11px] text-muted-foreground">{t("providers.dialog.protocolHint")}</p>
              </div>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => void handleSave()}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : isEdit ? t("common.save") : t("providers.dialog.add")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ProvidersTab({ searchInputRef }: { searchInputRef?: React.RefObject<HTMLInputElement> }) {
  const { t } = useTranslation()
  const catalog = useProviderStore((s) => s.catalog)
  const customProviders = useProviderStore((s) => s.customProviders)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const removeCustomProvider = useProviderStore((s) => s.removeCustomProvider)
  const refreshCustomProviders = useProviderStore((s) => s.refreshCustomProviders)

  const [query, setQuery] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editProvider, setEditProvider] = useState<CatalogProvider | undefined>(undefined)
  /** Nome que o cadastro abre preenchido (vem da busca sem resultado). */
  const [newProviderName, setNewProviderName] = useState("")
  const [detecting, setDetecting] = useState(false)
  const [detectResults, setDetectResults] = useState<DetectResult[] | null>(null)
  /**
   * Qual linha está com o campo de chave aberto, e o que já foi digitado nela.
   * Fica aqui (e não dentro da linha) porque a lista se re-renderiza quando o
   * catálogo ou as conexões mudam: se a linha remontasse no meio da digitação,
   * o campo aberto e o texto digitado iam junto. De quebra, só uma linha fica
   * em edição por vez, e fechar o campo sempre descarta o rascunho.
   */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const setEditing = useCallback(
    (providerId: string, editing: boolean) => {
      setEditingId(editing ? providerId : null)
      if (!editing) {
        setDrafts((current) => {
          if (!(providerId in current)) return current
          const next = { ...current }
          delete next[providerId]
          return next
        })
      }
    },
    [],
  )

  const setDraft = useCallback((providerId: string, value: string) => {
    setDrafts((current) => ({ ...current, [providerId]: value }))
  }, [])

  const customIds = useMemo(() => new Set(customProviders.map((p) => p.id)), [customProviders])

  /**
   * Personalizados separados por "roda neste computador" e "está na rede ou na
   * nuvem". A classificação sai da URL (nada persistido), então trocar o
   * endereço na edição move o card de grupo sozinho.
   */
  const customGroups = useMemo(
    () =>
      [
        {
          id: "local",
          label: t("providers.local.groupLocal"),
          items: customProviders.filter((p) => isLocalEndpoint(p.api)),
        },
        {
          id: "remote",
          label: t("providers.local.groupRemote"),
          items: customProviders.filter((p) => !isLocalEndpoint(p.api)),
        },
      ].filter((group) => group.items.length > 0),
    [customProviders, t],
  )

  /**
   * Abre o cadastro já com um nome sugerido — é o que liga a busca da nuvem
   * ("não achei esse provedor") ao cadastro de um provedor próprio.
   */
  const openNewProvider = (name = "") => {
    setNewProviderName(name)
    setEditProvider(undefined)
    setDialogOpen(true)
  }

  const providerIds = useMemo(() => {
    const all = Object.keys(catalog).filter((id) => !customIds.has(id))
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      return all.filter((id) => id.toLowerCase().includes(q) || catalog[id].name.toLowerCase().includes(q))
    }
    const sorted = [...all].sort((a, b) => {
      const aCon = connectedProviders.includes(a) ? 0 : 1
      const bCon = connectedProviders.includes(b) ? 0 : 1
      if (aCon !== bCon) return aCon - bCon
      return a.localeCompare(b)
    })
    return sorted
  }, [catalog, query, connectedProviders, customIds])

  const handleDetect = async () => {
    setDetecting(true)
    try {
      const results = await customProvidersApi.detect()
      setDetectResults(results)
      // O main adota os modelos encontrados no provedor correspondente;
      // recarregar aqui faz os cards (e o seletor) refletirem isso na hora.
      if (results.some((result) => result.detected && result.models.length > 0)) {
        await refreshCustomProviders()
      }
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("providers.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("providers.description")}
        </p>
      </div>

      {/* Provedores locais / customizados */}
      <div className="flex items-center gap-2">
        <Server className="size-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground">{t("providers.local.title")}</p>
        <div className="flex-1" />
        <Button size="icon-sm" variant="ghost" title={t("providers.local.detect")}
          disabled={detecting} onClick={() => void handleDetect()}>
          <RefreshCw className={cn("size-3", detecting && "animate-spin")} />
        </Button>
        <Button size="sm" variant="outline" className="gap-1 h-7 text-xs" onClick={() => openNewProvider()}>
          <Plus className="size-3" />
          {t("providers.local.add")}
        </Button>
      </div>

      {detectResults && detectResults.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-2">
          {detectResults.map((r) => (
            <div key={r.providerId} className="flex items-center gap-2 text-xs">
              {r.detected ? (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <Wifi className="size-2.5" />
                  {t("providers.detect.online")}
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                  <WifiOff className="size-2.5" />
                  {t("providers.detect.offline")}
                </Badge>
              )}
              <span className="font-medium">{r.name}</span>
              {r.detected && r.models.length > 0 && (
                <span className="text-muted-foreground">({t("providers.detect.models", { count: r.models.length })})</span>
              )}
              <span className="text-muted-foreground">{r.baseURL}</span>
              <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setDetectResults(null)}>
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {customGroups.map((group) => (
          <div key={group.id} className="flex flex-col gap-2">
            <p className="text-[11px] font-medium text-muted-foreground/80">{group.label}</p>
            {group.items.map((p) => (
              <CustomProviderCard
                key={p.id}
                provider={p}
                onEdit={() => {
                  setEditProvider(p)
                  setDialogOpen(true)
                }}
                onRemove={() => {
                  const id = p.id.replace(/^custom:/, "")
                  void removeCustomProvider(id)
                }}
              />
            ))}
          </div>
        ))}
        {customProviders.length === 0 && (
          <p className="py-2 text-center text-xs text-muted-foreground">
            {t("providers.local.none")}
          </p>
        )}
      </div>

      {/* Provedores da nuvem (catálogo models.dev) */}
      <div className="flex flex-col gap-2 border-t pt-3">
        <p className="text-xs font-medium text-muted-foreground">{t("providers.cloud.title")}</p>
        <input
          ref={searchInputRef}
          value={query}
          placeholder={t("providers.cloud.searchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 w-full min-w-0 rounded-md border border-input bg-input/20 px-2 py-0.5 text-sm transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs/relaxed file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 md:text-xs/relaxed dark:bg-input/30"
        />
        {providerIds.map((id) => (
          <ProviderRow
            key={id}
            providerId={id}
            editing={editingId === id}
            draft={drafts[id] ?? ""}
            onEdit={setEditing}
            onDraftChange={setDraft}
          />
        ))}
        {providerIds.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-4">
            <p className="text-center text-xs text-muted-foreground">{t("providers.cloud.none")}</p>
            {/*
              A busca sem resultado é o momento em que o usuário descobre que o
              provedor dele não está no catálogo — daí a oferta de cadastrar.
            */}
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => openNewProvider(query.trim())}
            >
              <Plus className="size-3" />
              {t("providers.cloud.addOwn")}
            </Button>
          </div>
        )}
      </div>

      <CustomProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editProvider={editProvider}
        initialName={newProviderName}
      />
    </div>
  )
}

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: SettingsTab
}

export function SettingsDialog({ open, onOpenChange, initialTab = "providers" }: SettingsDialogProps) {
  const { t } = useTranslation()
  const TABS = useTabs()
  const [tab, setTab] = useState<Exclude<SettingsTab, "mcp-skills">>(initialTab === "mcp-skills" ? "providers" : initialTab)
  const providerSearchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTab(initialTab === "mcp-skills" ? "providers" : initialTab)
  }, [initialTab, open])

  const active = TABS.find((tb) => tb.id === tab) ?? TABS[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm sm:max-w-4xl p-0 gap-0 overflow-hidden"
        showCloseButton
        initialFocus={tab === "providers" ? providerSearchRef : undefined}
      >
        <div className="flex flex-row h-[600px]">
          <nav className="w-48 shrink-0 border-r bg-muted/30 p-2">
            <DialogHeader className="px-2 py-2 text-left">
              <DialogTitle className="text-sm">{t("settings.title")}</DialogTitle>
              <DialogDescription className="text-[11px] sr-only">
                {t("settings.description")}
              </DialogDescription>
            </DialogHeader>
            <ul className="mt-1 flex flex-col gap-0.5">
              {TABS.map(({ id, label, icon: Icon, description, beta }) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => { if (id !== "mcp-skills") setTab(id) }}
                    title={description}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                      tab === id
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    {label}
                    {beta && (
                      <Badge variant="outline" className="ml-auto h-4 px-1 text-[9px] font-medium uppercase">
                        {t("settings.beta")}
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex-1 min-w-0 p-4">
            <div className="mb-3 flex items-center gap-2 border-b pb-2">
              <active.icon className="size-4 text-muted-foreground" />
              <p className="text-sm font-medium">{active.label}</p>
              {active.beta && (
                <Badge variant="outline" className="h-4 px-1 text-[9px] font-medium uppercase">
                  {t("settings.beta")}
                </Badge>
              )}
              <p className="text-[11px] text-muted-foreground">{active.description}</p>
            </div>
            <div className="h-[520px] min-w-0">
              {active.id === "providers" ? <ProvidersTab searchInputRef={providerSearchRef} /> : active.id === "autonomy" ? <PreferencesPanel /> : active.id === "appearance" ? <AppearancePanel /> : active.id === "notifications" ? <NotificationsPanel /> : active.id === "voice" ? <VoicePanel /> : active.id === "system" ? <SystemPanel /> : active.id === "browser" ? <BrowserPanel /> : active.id === "computer" ? <ComputerPanel /> : active.id === "howto" ? <HowToPanel /> : active.id === "about" ? <AboutPanel /> : <DataPanel />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Instância ÚNICA do SettingsDialog, montada na raiz do app e controlada pelo
 * `useSettingsUi`. Todo ponto de entrada (menu da conta, menu nativo do macOS,
 * comando /settings, "gerenciar provedores" do seletor de modelo) chama
 * `openSettings(tab)` e cai exatamente neste dialog — antes cada seletor
 * montava um SettingsDialog próprio dentro da sua árvore, e o do input de chat
 * herdava os handlers do PromptInput.
 */
export function SettingsDialogHost() {
  const open = useSettingsUi((s) => s.open)
  const tab = useSettingsUi((s) => s.tab)
  const setOpen = useSettingsUi((s) => s.setOpen)
  return <SettingsDialog open={open} onOpenChange={setOpen} initialTab={tab} />
}
