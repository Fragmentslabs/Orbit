import { useMemo, useState } from "react"
import { BrainIcon, CheckIcon, ChevronDownIcon, RotateCcwIcon, SettingsIcon } from "lucide-react"
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
import { usePermissionPrefs } from "@/src/stores/permission-prefs"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import type { DefaultModel, ActiveModeDefaults } from "@/src/stores/model-mode-prefs"
import type { BrainContextMode } from "@/src/stores/brain-prefs"
import { useBrainPrefs, useChatContext, useCodeContext } from "@/src/stores/brain-prefs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { PermissionMode, PermissionThresholds, RiskLevel, SensitivityLevel } from "@/shared/chat"

const MAX_MODELS_PER_PROVIDER = 40

type PrefsTab = "chat" | "code"

const MODE_META: Record<PermissionMode, { title: string; description: string }> = {
  ask: { title: "Modo Perguntar", description: "Máxima colaboração. Confirma cada ação sensível e cada decisão importante." },
  approve: { title: "Modo Approve", description: "Autonomia operacional: executa comandos de risco médio; pergunta nos altos risco e nas decisões estruturais." },
  full: { title: "Modo Full", description: "Máxima autonomia: executa e decide tudo dentro do piso absoluto de segurança (escrita em .git/, rm -rf fora do projeto) — sempre bloqueado." },
}

const TERMINAL_OPTIONS: { value: RiskLevel; label: string; hint: string }[] = [
  { value: "low", label: "Baixo", hint: "Pergunta para tudo que não for trivial (sem risco)" },
  { value: "medium", label: "Médio", hint: "Pergunta para risco médio (git push, .env) e alto (push --force, sudo)" },
  { value: "high", label: "Alto", hint: "Só pergunta para alto risco (sudo, rm -rf, push --force). Libera médio." },
]

const DECISIONS_OPTIONS: { value: SensitivityLevel; label: string; hint: string }[] = [
  { value: "low", label: "Baixa", hint: "Pergunta em toda decisão estrutural de produto/arquitetura" },
  { value: "medium", label: "Média", hint: "Decide escolhas básicas; pergunta decisões estruturais (DB, framework)" },
  { value: "high", label: "Alta", hint: "Decide tudo sozinho — nunca pergunta" },
]

function ModelField({
  label,
  value,
  onChange,
}: {
  label: string
  value: DefaultModel | null
  onChange: (v: DefaultModel | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
      <ModelSelector onOpenChange={setOpen} open={open}>
        <ModelSelectorTrigger render={<Button className="h-7 gap-1 px-1.5 text-xs" variant="outline" />}>
          {value ? (
            <>
              <ModelSelectorLogo provider={value.providerId} />
              <ModelSelectorName>{selectedModel?.name ?? value.modelId}</ModelSelectorName>
            </>
          ) : (
            <span className="text-muted-foreground">Nenhum</span>
          )}
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </ModelSelectorTrigger>
        <ModelSelectorContent>
          <ModelSelectorInput placeholder="Pesquisar modelos…" />
          <ModelSelectorList>
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
              onClick={() => { setOpen(false); setSettingsOpen(true) }}
            >
              <SettingsIcon className="size-3.5" />
              {groups.length === 0 ? "Configurar um provedor" : "Gerenciar provedores"}
            </Button>
          </div>
        </ModelSelectorContent>
      </ModelSelector>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
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
    { key: "orchestra", label: "Orquestra" },
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

function ModeSection({ mode }: { mode: PermissionMode }) {
  const thresholds = usePermissionPrefs((s) => s.thresholds[mode])
  const setThreshold = usePermissionPrefs((s) => s.setThreshold)
  const meta = MODE_META[mode]
  const t: PermissionThresholds = thresholds

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-sm font-semibold">{meta.title}</span>
      </div>
      <p className="mb-3 text-[11px] leading-tight text-muted-foreground">{meta.description}</p>

      <div className="flex gap-4">
        <div className="flex-1">
          <p className="mb-1 text-xs font-medium">Risco máximo no terminal</p>
          <SegmentedControl<RiskLevel>
            options={TERMINAL_OPTIONS}
            value={t.terminalAuto}
            onChange={(v) => setThreshold(mode, "terminalAuto", v)}
            className="w-full"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            {TERMINAL_OPTIONS.find((o) => o.value === t.terminalAuto)?.hint}
          </p>
        </div>
        <div className="flex-1">
          <p className="mb-1 text-xs font-medium">Sensibilidade para decisões</p>
          <SegmentedControl<SensitivityLevel>
            options={DECISIONS_OPTIONS}
            value={t.decisionsAuto}
            onChange={(v) => setThreshold(mode, "decisionsAuto", v)}
            className="w-full"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            {DECISIONS_OPTIONS.find((o) => o.value === t.decisionsAuto)?.hint}
          </p>
        </div>
      </div>
    </div>
  )
}

const CONTEXT_OPTIONS: { value: BrainContextMode; label: string }[] = [
  { value: "off", label: "Desligado" },
  { value: "all", label: "Ligado em todos chats" },
  { value: "memory", label: "Ligado em chats com modo memória ligado" },
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
    ? "Memórias de projetos em pastas anteriores são injetadas automaticamente no prompt."
    : "Memórias relevantes são automaticamente injetadas no prompt para dar contexto ao agente."

  return (
    <div className="border-t pt-3">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">Memória</p>
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
  const resetThresholds = usePermissionPrefs((s) => s.resetThresholds)
  const { codeModel, setCodeModel, subagentModel, setSubagentModel, orchestraModel, setOrchestraModel, codeActiveModes, setCodeActiveMode } = useModelModePrefs()

  return (
    <div className="flex flex-col gap-4">
      <ModelField label="Modelo padrão" value={codeModel} onChange={setCodeModel} />
      <ModelField label="Modelo de subagentes" value={subagentModel} onChange={setSubagentModel} />
      <ModelField label="Modelo de orquestra" value={orchestraModel} onChange={setOrchestraModel} />
      <ActiveModesSection modes={codeActiveModes} onChange={setCodeActiveMode} isCode={true} />
      <MemoriaSection isCode={true} />

      <div className="border-t pt-3">
        <p className="mb-3 text-xs font-semibold text-muted-foreground">Autonomia & Permissões</p>
        <div className="flex flex-col gap-6">
          <ModeSection mode="ask" />
          <ModeSection mode="approve" />
          <ModeSection mode="full" />
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground" onClick={resetThresholds}>
            <RotateCcwIcon className="size-3" />
            Restaurar padrões
          </Button>
        </div>
      </div>
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
          Configure modelos padrão, modos ativos e permissões para cada modo.
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
