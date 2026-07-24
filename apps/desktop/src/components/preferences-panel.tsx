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
import { SegmentedControl } from "@/components/ui/segmented-control"
import { SettingsDialog } from "@/src/components/settings-dialog"
import { useProviderStore } from "@/src/stores/provider-store"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import type { DefaultModel, ActiveModeDefaults } from "@/src/stores/model-mode-prefs"
import type { BrainContextMode } from "@/src/stores/brain-prefs"
import { useBrainPrefs, useChatContext, useCodeContext } from "@/src/stores/brain-prefs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const MAX_MODELS_PER_PROVIDER = 40

type PrefsTab = "chat" | "code"

function ModelField({
  label,
  value,
  onChange,
  nullLabel,
}: {
  label: string
  value: DefaultModel | null
  onChange: (v: DefaultModel | null) => void
  nullLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [skipFinalFocus, setSkipFinalFocus] = useState(false)
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)

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

  const selectedModel = value ? catalog[value.providerId]?.models[value.modelId] : undefined

  return (
    <div>
      <p className="mb-1 text-xs font-medium">{label}</p>
      <ModelSelector open={open} onOpenChange={setOpen}>
        <ModelSelectorTrigger render={<Button className="h-7 gap-1 px-1.5 text-xs" variant="outline" />}>
          {value ? (
            <>
              <ModelSelectorLogo provider={value.providerId} />
              <ModelSelectorName>{selectedModel?.name ?? value.modelId}</ModelSelectorName>
            </>
          ) : (
            <span className="text-muted-foreground">{nullLabel ?? "Nenhum"}</span>
          )}
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </ModelSelectorTrigger>
        <ModelSelectorContent finalFocus={skipFinalFocus ? false : undefined}>
          <ModelSelectorInput placeholder="Pesquisar modelos…" />
          <ModelSelectorList>
            {nullLabel && (
              <ModelSelectorItem
                onSelect={() => { onChange(null); setOpen(false) }}
                value={nullLabel}
                className="flex justify-between"
              >
                <span className="text-muted-foreground">{nullLabel}</span>
                {!value ? <CheckIcon className="size-4" /> : <div className="size-4" />}
              </ModelSelectorItem>
            )}
            <ModelSelectorEmpty>Nenhum modelo encontrado.</ModelSelectorEmpty>
            {groups.map(({ provider, models }) => (
              <ModelSelectorGroup heading={provider.name} key={provider.id}>
                {models.map((model) => (
                  <ModelSelectorItem
                    key={`${provider.id}/${model.id}`}
                    onSelect={() => {
                      onChange({ providerId: provider.id, modelId: model.id })
                      setOpen(false)
                    }}
                    value={`${provider.name} ${model.name} ${model.id}`}
                  >
                    <ModelSelectorLogo provider={provider.id} />
                    <ModelSelectorName>{model.name}</ModelSelectorName>
                    {model.reasoning && (
                      <BrainIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    {value?.providerId === provider.id && value.modelId === model.id ? (
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
              {groups.length === 0 ? "Configurar um provedor" : "Gerenciar provedores"}
            </Button>
          </div>
        </ModelSelectorContent>
      </ModelSelector>
      <SettingsDialog open={settingsOpen} onOpenChange={(next) => { setSettingsOpen(next); if (!next) setSkipFinalFocus(false) }} />
    </div>
  )
}

function ActiveModesSection({
  modes,
  onChange,
  isCode,
}: {
  modes: ActiveModeDefaults
  onChange: (key: keyof ActiveModeDefaults, value: boolean) => void
  isCode: boolean
}) {
  const items: Array<{ key: keyof ActiveModeDefaults; label: string }> = [
    { key: "simple", label: "Simples" },
    { key: "brain", label: "Memória" },
    { key: "thinking", label: "Thinking" },
    { key: "search", label: "Pesquisa" },
    ...(isCode ? [] : [{ key: "browser" as const, label: "Browser" }]),
    ...(isCode ? [{ key: "plan" as const, label: "Modo Plano" }] : []),
    { key: "subagents", label: "Subagentes" },
    ...(isCode ? [{ key: "orchestra" as const, label: "Orquestra" }] : []),
  ]

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Modos ativos por padrão</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key, !modes[key])}
            className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
              modes[key]
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

const CONTEXT_OPTIONS: { value: BrainContextMode; label: string; hint: string }[] = [
  { value: "off", label: "Nunca", hint: "Memórias não são injetadas no prompt" },
  { value: "all", label: "Sempre", hint: "Memórias são injetadas em toda conversa" },
  { value: "memory", label: "Só quando ativo", hint: "Injeta apenas com o toggle Memória ativado" },
]

function ContextSelect({ value, onChange }: {
  value: BrainContextMode
  onChange: (v: BrainContextMode) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as BrainContextMode)}>
      <SelectTrigger className="min-w-48">
        <SelectValue>
          {(v) => CONTEXT_OPTIONS.find((o) => o.value === v)?.label ?? v}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {CONTEXT_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MemoriaSection({ isCode }: { isCode: boolean }) {
  const context = isCode ? useCodeContext() : useChatContext()
  const setter = isCode
    ? useBrainPrefs((s) => s.setCodeContext)
    : useBrainPrefs((s) => s.setChatContext)

  const description = isCode
    ? "Memórias de projeto (decisões, convenções, estrutura) são injetadas no prompt automaticamente. O agente busca o restante sob demanda com a ferramenta memory_graph."
    : "Fatos permanentes, preferências e memórias sazonais são injetados no prompt pra respostas mais personalizadas e naturais."

  return (
    <div className="border-t pt-3">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">Injeção de contexto</p>
        <ContextSelect value={context} onChange={setter} />
      </div>
      <p className="text-[11px] leading-tight text-muted-foreground">{description}</p>
    </div>
  )
}

function ChatPrefs() {
  const { chatModel, setChatModel, chatActiveModes, setChatActiveMode } = useModelModePrefs()

  return (
    <div className="flex flex-col gap-4">
      <ModelField label="Modelo padrão" value={chatModel} onChange={setChatModel} />
      <ActiveModesSection modes={chatActiveModes} onChange={setChatActiveMode} isCode={false} />
      <MemoriaSection isCode={false} />
    </div>
  )
}

function CodePrefs() {
  const { codeModel, setCodeModel, subagentModel, setSubagentModel, orchestraModel, setOrchestraModel, codeActiveModes, setCodeActiveMode } = useModelModePrefs()
  const setWorkerModel = useProviderStore((s) => s.setWorkerModel)

  return (
    <div className="flex flex-col gap-4">
      <ModelField label="Modelo padrão" value={codeModel} onChange={setCodeModel} />
      <ModelField label="Modelo de subagentes" value={subagentModel} nullLabel="Mesmo que padrão" onChange={(m) => { setSubagentModel(m); setWorkerModel(m ?? codeModel) }} />
      <ModelField label="Modelo de orquestra" value={orchestraModel} onChange={setOrchestraModel} />
      <ActiveModesSection modes={codeActiveModes} onChange={setCodeActiveMode} isCode={true} />
      <MemoriaSection isCode={true} />
    </div>
  )
}

export function PreferencesPanel() {
  const [tab, setTab] = useState<PrefsTab>("chat")

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">Preferências</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Configure modelos padrão e modos ativos para cada modo.
        </p>
      </div>

      <SegmentedControl
        options={[
          { value: "chat" as const, label: "Chat" },
          { value: "code" as const, label: "Código" },
        ]}
        value={tab}
        onChange={(v) => setTab(v as PrefsTab)}
        className="w-full"
      />

      {tab === "chat" ? <ChatPrefs /> : <CodePrefs />}
    </div>
  )
}
