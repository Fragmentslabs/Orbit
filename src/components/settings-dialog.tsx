import { useMemo, useState } from "react"
import { Check, KeyRound, Trash2 } from "lucide-react"
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
import { useProviderStore } from "@/src/stores/provider-store"

/** Provedores em destaque, mostrados primeiro (mesma curadoria do opencode). */
const FEATURED_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "xai", "deepseek", "groq", "mistral"]

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

export function SettingsDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const [query, setQuery] = useState("")

  const providerIds = useMemo(() => {
    const all = Object.keys(catalog)
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      return all
        .filter((id) => id.toLowerCase().includes(q) || catalog[id].name.toLowerCase().includes(q))
        .slice(0, 30)
    }
    const featured = FEATURED_PROVIDERS.filter((id) => all.includes(id))
    const connectedExtra = connectedProviders.filter((id) => !featured.includes(id) && all.includes(id))
    return [...connectedExtra, ...featured]
  }, [catalog, query, connectedProviders])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Provedores de IA</DialogTitle>
          <DialogDescription>
            Adicione chaves de API para habilitar provedores. As chaves ficam salvas apenas neste
            computador. Pesquise para ver todos os {Object.keys(catalog).length} provedores do catálogo.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          placeholder="Pesquisar provedor…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {providerIds.map((id) => (
            <ProviderRow key={id} providerId={id} />
          ))}
          {providerIds.length === 0 && (
            <p className="py-4 text-center text-xs text-muted-foreground">Nenhum provedor encontrado</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
