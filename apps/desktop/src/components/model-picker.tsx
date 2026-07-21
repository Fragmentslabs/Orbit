import { useMemo, useState } from "react"
import { BrainIcon, CheckIcon, ChevronDownIcon, SettingsIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/src/components/ai/model-selector"
import { SettingsDialog } from "@/src/components/settings-dialog"
import { useProviderStore } from "@/src/stores/provider-store"

const MAX_MODELS_PER_PROVIDER = 40

/**
 * Seletor de modelos real: lista os modelos dos provedores conectados
 * (catálogo models.dev), agrupados por provedor, com indicador de reasoning.
 */
export function ModelPicker() {
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [skipFinalFocus, setSkipFinalFocus] = useState(false)
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const selected = useProviderStore((s) => s.selectedModel)
  const loading = useProviderStore((s) => s.loading)
  const error = useProviderStore((s) => s.error)
  const selectModel = useProviderStore((s) => s.selectModel)

  const groups = useMemo(
    () =>
      connectedProviders
        .filter((id) => catalog[id])
        .map((id) => ({
          provider: catalog[id],
          models: Object.values(catalog[id].models)
            .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
            .slice(0, MAX_MODELS_PER_PROVIDER),
        })),
    [catalog, connectedProviders],
  )

  const selectedModel = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined

  return (
    <>
      <ModelSelector open={open} onOpenChange={setOpen}>
        <ModelSelectorTrigger render={<Button className="h-7 gap-1 px-1.5 text-xs" variant="ghost" />}>
          <ModelSelectorLogo provider={selected?.providerId ?? "openai"} />
          <ModelSelectorName>
            {loading ? "Carregando..." : selectedModel?.name ?? (error ? "Erro" : "Selecionar modelo")}
          </ModelSelectorName>
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </ModelSelectorTrigger>
        <ModelSelectorContent finalFocus={skipFinalFocus ? false : undefined}>
          <ModelSelectorInput placeholder="Pesquisar modelos…" />
          <ModelSelectorList>
            <ModelSelectorEmpty>Nenhum modelo encontrado.</ModelSelectorEmpty>
            {groups.map(({ provider, models }) => (
              <ModelSelectorGroup heading={provider.name} key={provider.id}>
                {models.map((model) => (
                  <ModelSelectorItem
                    key={`${provider.id}/${model.id}`}
                    onSelect={() => {
                      selectModel(provider.id, model.id)
                      setOpen(false)
                    }}
                    value={`${provider.name} ${model.name} ${model.id}`}
                  >
                    <ModelSelectorLogo provider={provider.id} />
                    <ModelSelectorName>{model.name}</ModelSelectorName>
                    {model.reasoning && (
                      <BrainIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    {selected?.providerId === provider.id && selected.modelId === model.id ? (
                      <CheckIcon className="ml-auto size-4" />
                    ) : (
                      <div className="ml-auto size-4" />
                    )}
                  </ModelSelectorItem>
                ))}
              </ModelSelectorGroup>
            ))}
          </ModelSelectorList>
          <div className="border-t p-1">
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 text-xs"
              onClick={() => {
                setSkipFinalFocus(true)
                setOpen(false)
                // Aguarda o dialog de seleção fechar completamente (animação ~100ms)
                // para evitar conflito de foco com o input autofocus do settings.
                setTimeout(() => setSettingsOpen(true), 120)
              }}
            >
              <SettingsIcon className="size-3.5" />
              {groups.length === 0 ? "Configurar um provedor para começar" : "Gerenciar provedores"}
            </Button>
          </div>
        </ModelSelectorContent>
      </ModelSelector>
      <SettingsDialog open={settingsOpen} onOpenChange={(next) => { setSettingsOpen(next); if (!next) setSkipFinalFocus(false) }} />
    </>
  )
}
