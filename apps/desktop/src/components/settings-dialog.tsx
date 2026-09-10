import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Bell, BookOpen, Database, KeyRound, Palette, Settings2, Shield, Trash2, Check, Plus, Wifi, WifiOff, RefreshCw, Server, X, Pencil, Info } from "lucide-react"
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
import { NotificationsPanel } from "@/src/components/notifications-panel"
import { AboutPanel } from "@/src/components/about-panel"
import { useProviderStore } from "@/src/stores/provider-store"
import { customProvidersApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"

import { useSettingsUi, type SettingsTab } from "@/src/stores/settings-ui"
import type { DetectResult } from "@/src/lib/ipc"

interface TabDef {
  id: SettingsTab
  label: string
  icon: typeof Shield
  description: string
}

function useTabs(): TabDef[] {
  const { t } = useTranslation()
  return [
    { id: "providers", label: t("settings.tabs.providers.label"), icon: KeyRound, description: t("settings.tabs.providers.description") },
    { id: "autonomy", label: t("settings.tabs.autonomy.label"), icon: Shield, description: t("settings.tabs.autonomy.description") },
    { id: "howto", label: t("settings.tabs.howto.label"), icon: BookOpen, description: t("settings.tabs.howto.description") },
    { id: "appearance", label: t("settings.tabs.appearance.label"), icon: Palette, description: t("settings.tabs.appearance.description") },
    { id: "notifications", label: t("settings.tabs.notifications.label"), icon: Bell, description: t("settings.tabs.notifications.description") },
    { id: "system", label: t("settings.tabs.system.label"), icon: Settings2, description: t("settings.tabs.system.description") },
    { id: "data", label: t("settings.tabs.data.label"), icon: Database, description: t("settings.tabs.data.description") },
    { id: "about", label: t("settings.tabs.about.label"), icon: Info, description: t("settings.tabs.about.description") },
  ]
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

function CustomProviderCard({
  provider,
  onEdit,
  onRemove,
}: {
  provider: { id: string; name: string; api?: string }
  onEdit: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const connected = useProviderStore((s) => s.connectedProviders.includes(provider.id))

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{provider.name}</span>
        {connected ? (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <Wifi className="size-3" />
            {t("providers.connected")}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
            <WifiOff className="size-3" />
            {t("providers.local.notConnected")}
          </Badge>
        )}
        <Button size="icon-sm" variant="ghost" title={t("providers.local.edit")} onClick={onEdit}>
          <Pencil className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" title={t("providers.local.remove")} onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {provider.api && (
        <p className="truncate text-[11px] text-muted-foreground">{provider.api}</p>
      )}
    </div>
  )
}

function CustomProviderDialog({
  open,
  onOpenChange,
  editProvider,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editProvider?: { id: string; name: string; api?: string }
}) {
  const { t } = useTranslation()
  const addCustomProvider = useProviderStore((s) => s.addCustomProvider)
  const updateCustomProvider = useProviderStore((s) => s.updateCustomProvider)

  const isEdit = !!editProvider
  const rawId = editProvider ? editProvider.id.replace(/^custom:/, "") : ""

  const [id, setId] = useState(rawId)
  const [name, setName] = useState(editProvider?.name ?? "")
  const [baseURL, setBaseURL] = useState(editProvider?.api ?? "http://localhost:11434/v1")
  const [apiKey, setApiKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (open && editProvider) {
      setId(editProvider.id.replace(/^custom:/, ""))
      setName(editProvider.name)
      setBaseURL(editProvider.api ?? "http://localhost:11434/v1")
      setApiKey("")
      setError("")
    } else if (open) {
      setId("")
      setName("")
      setBaseURL("http://localhost:11434/v1")
      setApiKey("")
      setError("")
    }
  }, [open, editProvider])

  const handleSave = async () => {
    if (!id.trim() || !name.trim() || !baseURL.trim()) return
    setSaving(true)
    setError("")
    try {
      if (isEdit) {
        await updateCustomProvider(rawId, {
          name: name.trim(),
          baseURL: baseURL.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        })
      } else {
        await addCustomProvider(id.trim(), name.trim(), baseURL.trim(), apiKey.trim() || undefined)
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
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground">{t("providers.dialog.id")}</label>
              <Input
                value={id}
                placeholder="ollama-local"
                disabled={isEdit}
                onChange={(e) => setId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
              />
            </div>
            <div className="flex-[2]">
              <label className="text-xs text-muted-foreground">{t("providers.dialog.name")}</label>
              <Input value={name} placeholder={t("providers.dialog.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t("providers.dialog.baseUrl")}</label>
            <Input value={baseURL} placeholder="http://localhost:11434/v1" onChange={(e) => setBaseURL(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {t("providers.dialog.apiKey")} <span className="text-muted-foreground/50">{t("providers.dialog.optional")}</span>
            </label>
            <Input
              type="password"
              value={apiKey}
              placeholder={t("providers.dialog.apiKeyPlaceholder")}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={!id.trim() || !name.trim() || !baseURL.trim() || saving} onClick={() => void handleSave()}>
              {isEdit ? t("common.save") : t("common.add")}
            </Button>
          </div>
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

  const [query, setQuery] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editProvider, setEditProvider] = useState<{ id: string; name: string; api?: string } | undefined>(undefined)
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
        <Button size="sm" variant="outline" className="gap-1 h-7 text-xs" onClick={() => { setEditProvider(undefined); setDialogOpen(true) }}>
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

      <div className="flex flex-col gap-2">
        {customProviders.map((p) => (
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
          <p className="py-4 text-center text-xs text-muted-foreground">{t("providers.cloud.none")}</p>
        )}
      </div>

      <CustomProviderDialog open={dialogOpen} onOpenChange={setDialogOpen} editProvider={editProvider} />
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
              {TABS.map(({ id, label, icon: Icon, description }) => (
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
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex-1 min-w-0 p-4">
            <div className="mb-3 flex items-center gap-2 border-b pb-2">
              <active.icon className="size-4 text-muted-foreground" />
              <p className="text-sm font-medium">{active.label}</p>
              <p className="text-[11px] text-muted-foreground">{active.description}</p>
            </div>
            <div className="h-[520px] min-w-0">
              {tab === "providers" ? <ProvidersTab searchInputRef={providerSearchRef} /> : tab === "autonomy" ? <PreferencesPanel /> : tab === "appearance" ? <AppearancePanel /> : tab === "notifications" ? <NotificationsPanel /> : tab === "system" ? <SystemPanel /> : tab === "howto" ? <HowToPanel /> : tab === "about" ? <AboutPanel /> : <DataPanel />}
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
