import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, ChevronDownIcon, FolderIcon, LanguagesIcon, SettingsIcon } from "lucide-react"
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
import { LOCALE_LABELS, SUPPORTED_LOCALES, useLocaleStore, type AppLocale } from "@/src/stores/locale-store"

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
  const { t } = useTranslation()

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
            <span className="text-muted-foreground">{nullLabel ?? t("preferences.none")}</span>
          )}
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </ModelSelectorTrigger>
        <ModelSelectorContent finalFocus={skipFinalFocus ? false : undefined}>
          <ModelSelectorInput placeholder={t("preferences.searchModels")} />
          <ModelSelectorList>
            {nullLabel && (
              <ModelSelectorItem
                onSelect={() => { onChange(null); setOpen(false) }}
                value={nullLabel}
                className={!value ? "bg-primary/10" : undefined}
              >
                <span className="text-muted-foreground">{nullLabel}</span>
              </ModelSelectorItem>
            )}
            <ModelSelectorEmpty>{t("preferences.noModelsFound")}</ModelSelectorEmpty>
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
                    className={
                      value?.providerId === provider.id && value.modelId === model.id
                        ? "bg-primary/10"
                        : undefined
                    }
                  >
                    <ModelSelectorLogo provider={provider.id} />
                    <ModelSelectorName>{model.name}</ModelSelectorName>
                    {model.reasoning && (
                      <BrainIcon className="size-3 shrink-0 text-muted-foreground" />
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
              {groups.length === 0 ? t("preferences.configureProvider") : t("preferences.manageProviders")}
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
  const { t } = useTranslation()
  const items: Array<{ key: keyof ActiveModeDefaults; label: string }> = [
    { key: "simple", label: t("preferences.modes.simple") },
    { key: "brain", label: t("preferences.modes.brain") },
    { key: "thinking", label: t("preferences.modes.thinking") },
    { key: "search", label: t("preferences.modes.search") },
    ...(isCode ? [] : [{ key: "browser" as const, label: t("preferences.modes.browser") }]),
    ...(isCode ? [{ key: "plan" as const, label: t("preferences.modes.plan") }] : []),
    { key: "subagents", label: t("preferences.modes.subagents") },
    ...(isCode ? [{ key: "orchestra" as const, label: t("preferences.modes.orchestra") }] : []),
  ]

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("preferences.activeModes")}</p>
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

function useContextOptions(): { value: BrainContextMode; label: string; hint: string }[] {
  const { t } = useTranslation()
  return [
    { value: "off", label: t("preferences.context.off.label"), hint: t("preferences.context.off.hint") },
    { value: "all", label: t("preferences.context.all.label"), hint: t("preferences.context.all.hint") },
    { value: "memory", label: t("preferences.context.memory.label"), hint: t("preferences.context.memory.hint") },
  ]
}

function ContextSelect({ value, onChange }: {
  value: BrainContextMode
  onChange: (v: BrainContextMode) => void
}) {
  const options = useContextOptions()
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as BrainContextMode)}>
      <SelectTrigger className="min-w-48">
        <SelectValue>
          {(v) => options.find((o) => o.value === v)?.label ?? v}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MemoriaSection({ isCode }: { isCode: boolean }) {
  const { t } = useTranslation()
  const context = isCode ? useCodeContext() : useChatContext()
  const setter = isCode
    ? useBrainPrefs((s) => s.setCodeContext)
    : useBrainPrefs((s) => s.setChatContext)

  const description = isCode
    ? t("preferences.context.descriptionCode")
    : t("preferences.context.descriptionChat")

  return (
    <div className="border-t pt-3">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">{t("preferences.context.title")}</p>
        <ContextSelect value={context} onChange={setter} />
      </div>
      <p className="text-[11px] leading-tight text-muted-foreground">{description}</p>
    </div>
  )
}

function ChatPrefs() {
  const { t } = useTranslation()
  const { chatModel, setChatModel, chatActiveModes, setChatActiveMode } = useModelModePrefs()

  return (
    <div className="flex flex-col gap-4">
      <ModelField label={t("preferences.defaultModel")} value={chatModel} onChange={setChatModel} />
      <ActiveModesSection modes={chatActiveModes} onChange={setChatActiveMode} isCode={false} />
      <MemoriaSection isCode={false} />
    </div>
  )
}

function CodePrefs() {
  const { t } = useTranslation()
  const { codeModel, setCodeModel, subagentModel, setSubagentModel, orchestraModel, setOrchestraModel, codeActiveModes, setCodeActiveMode, autoCreateFolders, setAutoCreateFolders } = useModelModePrefs()
  const setWorkerModel = useProviderStore((s) => s.setWorkerModel)

  return (
    <div className="flex flex-col gap-4">
      <ModelField label={t("preferences.defaultModel")} value={codeModel} onChange={setCodeModel} />
      <ModelField label={t("preferences.subagentModel")} value={subagentModel} nullLabel={t("preferences.sameAsDefault")} onChange={(m) => { setSubagentModel(m); setWorkerModel(m ?? codeModel) }} />
      <ModelField label={t("preferences.orchestraModel")} value={orchestraModel} onChange={setOrchestraModel} />
      <ActiveModesSection modes={codeActiveModes} onChange={setCodeActiveMode} isCode={true} />
      <MemoriaSection isCode={true} />
      <div className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-accent/50">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
          <FolderIcon className="size-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium">{t("preferences.autoFolders.title")}</p>
          <p className="text-[11px] text-muted-foreground leading-tight">
            {t("preferences.autoFolders.description")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={autoCreateFolders}
          onClick={() => setAutoCreateFolders(!autoCreateFolders)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
            autoCreateFolders ? "bg-primary" : "bg-input"
          }`}
        >
          <span
            className={`pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
              autoCreateFolders ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  )
}

function LanguageSection() {
  const { t } = useTranslation()
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)

  return (
    <div className="border-t pt-4">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{t("preferences.language.title")}</p>
      <div className="flex gap-2">
        {SUPPORTED_LOCALES.map((value) => {
          const active = locale === value
          return (
            <button
              key={value}
              type="button"
              onClick={() => setLocale(value as AppLocale)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                active
                  ? "border-ring bg-accent text-accent-foreground shadow-sm"
                  : "border-input bg-background text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              <LanguagesIcon className="size-4" />
              {LOCALE_LABELS[value]}
            </button>
          )
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/70">
        {t("preferences.language.description")}
      </p>
    </div>
  )
}

export function PreferencesPanel() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<PrefsTab>("chat")

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("preferences.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("preferences.description")}
        </p>
      </div>

      <SegmentedControl
        options={[
          { value: "chat" as const, label: t("preferences.tabChat") },
          { value: "code" as const, label: t("preferences.tabCode") },
        ]}
        value={tab}
        onChange={(v) => setTab(v as PrefsTab)}
        className="w-full"
      />

      {tab === "chat" ? <ChatPrefs /> : <CodePrefs />}
      <LanguageSection />
    </div>
  )
}
