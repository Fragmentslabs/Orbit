import { useEffect, useMemo, useState } from "react"
import { BarChart3, Database, KeyRound, Puzzle, Shield, Trash2, Check } from "lucide-react"
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
import { useProviderStore } from "@/src/stores/provider-store"
import { cn } from "@/lib/utils"

import type { SettingsTab } from "@/src/stores/settings-ui"

interface TabDef {
  id: SettingsTab
  label: string
  icon: typeof Shield
  description: string
}

const TABS: TabDef[] = [
  { id: "providers", label: "Provedores", icon: KeyRound, description: "Chaves de API dos provedores de IA." },
  { id: "autonomy", label: "Preferências", icon: Shield, description: "Preferências gerais, modelos padrão e permissões." },
  { id: "mcp-skills", label: "Ferramentas", icon: Puzzle, description: "Servidores MCP e skills do usuário." },
  { id: "analytics", label: "Uso e Limites", icon: BarChart3, description: "Estatísticas de uso e consumo de tokens." },
  { id: "data", label: "Dados", icon: Database, description: "Exportar e importar seus dados." },
]

function ProviderRow({ providerId }: { providerId: string }) {
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
}

function ProvidersTab() {
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const [query, setQuery] = useState("")

  const providerIds = useMemo(() => {
    const all = Object.keys(catalog)
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      return all.filter((id) => id.toLowerCase().includes(q) || catalog[id].name.toLowerCase().includes(q))
    }
    // Conectados primeiro, depois ordem alfabética
    const sorted = [...all].sort((a, b) => {
      const aCon = connectedProviders.includes(a) ? 0 : 1
      const bCon = connectedProviders.includes(b) ? 0 : 1
      if (aCon !== bCon) return aCon - bCon
      return a.localeCompare(b)
    })
    return sorted
  }, [catalog, query, connectedProviders])

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">Provedores de IA</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Adicione chaves de API para habilitar provedores. As chaves ficam salvas apenas neste
          computador. {Object.keys(catalog).length} provedores disponíveis no catálogo.
        </p>
      </div>
      <Input value={query} placeholder="Pesquisar provedor…" onChange={(e) => setQuery(e.target.value)} />
      <div className="flex flex-col gap-2">
        {providerIds.map((id) => (
          <ProviderRow key={id} providerId={id} />
        ))}
        {providerIds.length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground">Nenhum provedor encontrado</p>
        )}
      </div>
    </div>
  )
}

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Aba ativa inicial — útil para abrir direto em "autonomy" via atalho inline. */
  initialTab?: SettingsTab
}

export function SettingsDialog({ open, onOpenChange, initialTab = "providers" }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)

  useEffect(() => {
    if (open) setTab(initialTab)
  }, [initialTab, open])

  const active = TABS.find((t) => t.id === tab) ?? TABS[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-4xl p-0 gap-0 overflow-hidden" showCloseButton>
        <div className="flex flex-row h-[600px]">
          {/* Sidebar de abas */}
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

          {/* Área direita: conteúdo ativo */}
          <div className="flex-1 min-w-0 p-4">
            <div className="mb-3 flex items-center gap-2 border-b pb-2">
              <active.icon className="size-4 text-muted-foreground" />
              <p className="text-sm font-medium">{active.label}</p>
              <p className="text-[11px] text-muted-foreground">{active.description}</p>
            </div>
            <div className="h-[520px] min-w-0">
              {tab === "providers" ? <ProvidersTab /> : tab === "autonomy" ? <PreferencesPanel /> : tab === "mcp-skills" ? <McpSkillsPanel /> : tab === "analytics" ? <AnalyticsPanel /> : <DataPanel />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
