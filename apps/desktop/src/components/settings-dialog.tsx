import { memo, useEffect, useMemo, useRef, useState } from "react"
import { BarChart3, BookOpen, Database, KeyRound, Puzzle, Shield, Trash2, Check, Plus, Wifi, WifiOff, RefreshCw, Server, X, Pencil } from "lucide-react"
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
import { McpSkillsPanel } from "@/src/components/mcp-skills-panel"
import { AnalyticsPanel } from "@/src/components/analytics-panel"
import { DataPanel } from "@/src/components/data-panel"
import { HowToPanel } from "@/src/components/how-to-panel"
import { useProviderStore } from "@/src/stores/provider-store"
import { customProvidersApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"

import type { SettingsTab } from "@/src/stores/settings-ui"
import type { DetectResult } from "@/src/lib/ipc"

interface TabDef {
  id: SettingsTab
  label: string
  icon: typeof Shield
  description: string
}

const TABS: TabDef[] = [
  { id: "providers", label: "Provedores", icon: KeyRound, description: "Chaves de API dos provedores de IA." },
  { id: "autonomy", label: "Preferências", icon: Shield, description: "Modelos padrão, modos ativos e memória." },
  { id: "mcp-skills", label: "Ferramentas", icon: Puzzle, description: "Servidores MCP e skills do usuário." },
  { id: "howto", label: "Como Funciona", icon: BookOpen, description: "Explicação dos modos e combinações." },
  { id: "analytics", label: "Uso e Limites", icon: BarChart3, description: "Estatísticas de uso e consumo de tokens." },
  { id: "data", label: "Dados", icon: Database, description: "Exportar e importar seus dados." },
]

const ProviderRow = memo(function ProviderRow({ providerId }: { providerId: string }) {
  const provider = useProviderStore((s) => s.catalog[providerId])
  const connected = useProviderStore((s) => s.connectedProviders.includes(providerId))
  const setApiKey = useProviderStore((s) => s.setApiKey)
  const removeApiKey = useProviderStore((s) => s.removeApiKey)

  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState("")
  const [saving, setSaving] = useState(false)

  if (!provider) return null

  const save = async () => {
    if (!key.trim()) return
    setSaving(true)
    await setApiKey(providerId, key.trim())
    setSaving(false)
    setEditing(false)
    setKey("")
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <ModelSelectorLogo provider={providerId} className="size-4" />
        <span className="flex-1 truncate text-sm font-medium">{provider.name}</span>
        {connected && (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <Check className="size-3" />
            Conectado
          </Badge>
        )}
        {connected ? (
          <Button
            size="icon-sm"
            variant="ghost"
            title="Remover chave"
            onClick={() => void removeApiKey(providerId)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : (
          !editing && (
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditing(true)}>
              <KeyRound className="size-3.5" />
              Adicionar chave
            </Button>
          )
        )}
      </div>
      {editing && !connected && (
        <div className="flex gap-2">
          <Input
            autoFocus
            type="password"
            value={key}
            placeholder={`Chave de API do ${provider.name}`}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save()
              if (e.key === "Escape") setEditing(false)
            }}
          />
          <Button disabled={!key.trim() || saving} onClick={() => void save()}>
            Salvar
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
  const connected = useProviderStore((s) => s.connectedProviders.includes(provider.id))

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{provider.name}</span>
        {connected ? (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <Wifi className="size-3" />
            Conectado
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
            <WifiOff className="size-3" />
            Não conectado
          </Badge>
        )}
        <Button size="icon-sm" variant="ghost" title="Editar" onClick={onEdit}>
          <Pencil className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" title="Remover" onClick={onRemove}>
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
          <DialogTitle className="text-sm">{isEdit ? "Editar provedor local" : "Adicionar provedor local"}</DialogTitle>
          <DialogDescription className="text-xs">
            Configure um servidor local compatível com OpenAI (Ollama, LM Studio, etc.).
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground">ID</label>
              <Input
                value={id}
                placeholder="ollama-local"
                disabled={isEdit}
                onChange={(e) => setId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
              />
            </div>
            <div className="flex-[2]">
              <label className="text-xs text-muted-foreground">Nome</label>
              <Input value={name} placeholder="Meu Ollama" onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Base URL</label>
            <Input value={baseURL} placeholder="http://localhost:11434/v1" onChange={(e) => setBaseURL(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Chave de API <span className="text-muted-foreground/50">(opcional)</span>
            </label>
            <Input
              type="password"
              value={apiKey}
              placeholder="Deixe em branco para manter a atual"
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button size="sm" disabled={!id.trim() || !name.trim() || !baseURL.trim() || saving} onClick={() => void handleSave()}>
              {isEdit ? "Salvar" : "Adicionar"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ProvidersTab({ searchInputRef }: { searchInputRef?: React.RefObject<HTMLInputElement> }) {
  const catalog = useProviderStore((s) => s.catalog)
  const customProviders = useProviderStore((s) => s.customProviders)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const removeCustomProvider = useProviderStore((s) => s.removeCustomProvider)

  const [query, setQuery] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editProvider, setEditProvider] = useState<{ id: string; name: string; api?: string } | undefined>(undefined)
  const [detecting, setDetecting] = useState(false)
  const [detectResults, setDetectResults] = useState<DetectResult[] | null>(null)

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
        <p className="text-sm font-semibold">Provedores de IA</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Adicione chaves de API para habilitar provedores. As chaves ficam salvas apenas neste
          computador.
        </p>
      </div>

      {/* Provedores locais / customizados */}
      <div className="flex items-center gap-2">
        <Server className="size-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground">Provedores Locais</p>
        <div className="flex-1" />
        <Button size="icon-sm" variant="ghost" title="Detectar servidores locais"
          disabled={detecting} onClick={() => void handleDetect()}>
          <RefreshCw className={cn("size-3", detecting && "animate-spin")} />
        </Button>
        <Button size="sm" variant="outline" className="gap-1 h-7 text-xs" onClick={() => { setEditProvider(undefined); setDialogOpen(true) }}>
          <Plus className="size-3" />
          Adicionar
        </Button>
      </div>

      {detectResults && detectResults.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-2">
          {detectResults.map((r) => (
            <div key={r.providerId} className="flex items-center gap-2 text-xs">
              {r.detected ? (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <Wifi className="size-2.5" />
                  Online
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                  <WifiOff className="size-2.5" />
                  Offline
                </Badge>
              )}
              <span className="font-medium">{r.name}</span>
              {r.detected && r.models.length > 0 && (
                <span className="text-muted-foreground">({r.models.length} modelos)</span>
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
            Nenhum provedor local configurado. Adicione um ou use "Detectar".
          </p>
        )}
      </div>

      {/* Provedores da nuvem (catálogo models.dev) */}
      <div className="flex flex-col gap-2 border-t pt-3">
        <p className="text-xs font-medium text-muted-foreground">Provedores da Nuvem</p>
        <input
          ref={searchInputRef}
          value={query}
          placeholder="Pesquisar provedor…"
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 w-full min-w-0 rounded-md border border-input bg-input/20 px-2 py-0.5 text-sm transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs/relaxed file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 md:text-xs/relaxed dark:bg-input/30"
        />
        {providerIds.map((id) => (
          <ProviderRow key={id} providerId={id} />
        ))}
        {providerIds.length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground">Nenhum provedor encontrado</p>
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
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const providerSearchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTab(initialTab)
  }, [initialTab, open])

  const active = TABS.find((t) => t.id === tab) ?? TABS[0]

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
              <DialogTitle className="text-sm">Configurações</DialogTitle>
              <DialogDescription className="text-[11px] sr-only">
                Configurações do Orbit
              </DialogDescription>
            </DialogHeader>
            <ul className="mt-1 flex flex-col gap-0.5">
              {TABS.map(({ id, label, icon: Icon, description }) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => setTab(id)}
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
              {tab === "providers" ? <ProvidersTab searchInputRef={providerSearchRef} /> : tab === "autonomy" ? <PreferencesPanel /> : tab === "mcp-skills" ? <McpSkillsPanel /> : tab === "howto" ? <HowToPanel /> : tab === "analytics" ? <AnalyticsPanel /> : <DataPanel />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
