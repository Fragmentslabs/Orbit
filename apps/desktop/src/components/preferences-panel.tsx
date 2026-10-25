import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlignLeft,
  Bot,
  BrainCircuit,
  Eye,
  FileText,
  FolderIcon,
  Globe,
  LanguagesIcon,
  Network,
  Search,
  Sparkles,
} from "lucide-react"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { ModelField } from "@/src/components/model-field"
import { ModelThinkingMenu, ThinkingMenu } from "@/src/components/thinking-menu"
import { GeneralSettings } from "@/src/components/general-settings"
import { WorktreeSettings } from "@/src/components/worktree-settings"
import { useAppSettings } from "@/src/stores/app-settings"
import { PERSONA_NOTE_MAX, personaPromptLines, type PersonaStyle } from "@shared/persona"
import { useProviderStore } from "@/src/stores/provider-store"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import type { ActiveModeDefaults } from "@/src/stores/model-mode-prefs"
import type { BrainContextMode } from "@/src/stores/brain-prefs"
import { useBrainPrefs } from "@/src/stores/brain-prefs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LOCALE_LABELS, SUPPORTED_LOCALES, useLocaleStore, type AppLocale } from "@/src/stores/locale-store"

type PrefsTab = "chat" | "code"

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
  const items: Array<{ key: keyof ActiveModeDefaults; label: string; icon: typeof Search }> = [
    { key: "simple", label: t("preferences.modes.simple"), icon: AlignLeft },
    { key: "brain", label: t("preferences.modes.brain"), icon: BrainCircuit },
    { key: "thinking", label: t("preferences.modes.thinking"), icon: Sparkles },
    { key: "search", label: t("preferences.modes.search"), icon: Search },
    { key: "vision", label: t("preferences.modes.vision"), icon: Eye },
    ...(isCode ? [] : [{ key: "browser" as const, label: t("preferences.modes.browser"), icon: Globe }]),
    ...(isCode ? [{ key: "plan" as const, label: t("preferences.modes.plan"), icon: FileText }] : []),
    { key: "subagents", label: t("preferences.modes.subagents"), icon: Bot },
    ...(isCode ? [{ key: "orchestra" as const, label: t("preferences.modes.orchestra"), icon: Network }] : []),
  ]

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("preferences.activeModes")}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key, !modes[key])}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
              modes[key]
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
          >
            <Icon className="size-3.5" />
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
  // A condição vai DENTRO do seletor: chamar um hook ou outro conforme a
  // prop deixa a ordem de hooks dependendo dela. Hoje funciona porque cada
  // call site passa um `isCode` fixo, mas basta alguém tornar a prop dinâmica
  // para quebrar em runtime.
  const context = useBrainPrefs((s) => (isCode ? s.codeContext : s.chatContext))
  const setter = useBrainPrefs((s) => (isCode ? s.setCodeContext : s.setChatContext))

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
      <ModelField label={t("preferences.defaultModel")} value={chatModel} onChange={setChatModel} action={<ModelThinkingMenu model={chatModel} />} />
      <ActiveModesSection modes={chatActiveModes} onChange={setChatActiveMode} isCode={false} />
      <MemoriaSection isCode={false} />
    </div>
  )
}

function CodePrefs() {
  const { t } = useTranslation()
  const { codeModel, setCodeModel, codeActiveModes, setCodeActiveMode, autoCreateFolders, setAutoCreateFolders } = useModelModePrefs()
  // Subagentes e orquestra: o mesmo estado das engrenagens do "+" (provider-store),
  // sincronizado com o celular — mudar aqui muda lá, e vice-versa.
  const workerModel = useProviderStore((s) => s.workerModel)
  const setWorkerModel = useProviderStore((s) => s.setWorkerModel)
  const workerReasoning = useProviderStore((s) => s.workerReasoning)
  const setWorkerReasoning = useProviderStore((s) => s.setWorkerReasoning)
  const orchestratorModel = useProviderStore((s) => s.orchestratorModel)
  const setOrchestratorModel = useProviderStore((s) => s.setOrchestratorModel)
  const orchestratorReasoning = useProviderStore((s) => s.orchestratorReasoning)
  const setOrchestratorReasoning = useProviderStore((s) => s.setOrchestratorReasoning)

  return (
    <div className="flex flex-col gap-4">
      <ModelField label={t("preferences.defaultModel")} value={codeModel} onChange={setCodeModel} action={<ModelThinkingMenu model={codeModel} />} />
      {/* Limpar grava null: null é o que faz o worker (ou o condutor) seguir o
          modelo do chat — o mesmo contrato do diálogo do "+". Trocar de modelo
          volta o raciocínio a desligado: outro modelo, outros níveis. */}
      <ModelField
        label={t("preferences.subagentModel")}
        value={workerModel}
        nullLabel={t("preferences.sameAsMainModel")}
        onChange={(m) => {
          setWorkerModel(m)
          setWorkerReasoning(null)
        }}
        action={<ThinkingMenu model={workerModel} value={workerReasoning} onChange={setWorkerReasoning} />}
      />
      <ModelField
        label={t("preferences.orchestraModel")}
        value={orchestratorModel}
        nullLabel={t("preferences.sameAsMainModel")}
        onChange={(m) => {
          setOrchestratorModel(m)
          setOrchestratorReasoning(null)
        }}
        action={<ThinkingMenu model={orchestratorModel} value={orchestratorReasoning} onChange={setOrchestratorReasoning} />}
      />
      <ActiveModesSection modes={codeActiveModes} onChange={setCodeActiveMode} isCode={true} />
      <MemoriaSection isCode={true} />
      <div className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-accent/50">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <FolderIcon className="size-4 text-muted-foreground" />
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
      <WorktreeSettings />
    </div>
  )
}

function LanguageSection() {
  const { t } = useTranslation()
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)

  return (
    <div>
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
              {value === "system" ? t("preferences.language.system") : LOCALE_LABELS[value]}
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



/** Ordem em que os estilos aparecem na tela. */
const PERSONA_OPTIONS: PersonaStyle[] = ["default", "direct", "mentor", "technical"]

/**
 * Como o Orbit fala. Vale nos dois modos, por isso fica acima das abas.
 *
 * O ajuste é COMPLEMENTO, não edição do prompt: o texto que o modelo lê vive
 * em inglês no pacote compartilhado, e o usuário escreve na língua dele uma
 * frase que se soma ao estilo. O "ver o texto exato" mostra o literal, somente
 * leitura — quem quiser conferir confere, e ninguém quebra a identidade sem
 * perceber.
 */
function BehaviorSection() {
  const { t } = useTranslation()
  const persona = useAppSettings((s) => s.settings.persona)
  const update = useAppSettings((s) => s.update)
  const [showPrompt, setShowPrompt] = useState(false)
  // Composição do chat (estilo + ajuste); no código entra mais uma linha de
  // calibração de registro que não interessa mostrar aqui.
  const exact = personaPromptLines(persona.style, persona.note, "chat").join("\n\n")

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("preferences.behavior.title")}</p>
      <div className="grid grid-cols-2 gap-1.5">
        {PERSONA_OPTIONS.map((value) => {
          const active = persona.style === value
          return (
            <button
              key={value}
              type="button"
              onClick={() => update({ persona: { ...persona, style: value } })}
              aria-pressed={active}
              className={`rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                active
                  ? "border-ring bg-accent shadow-sm"
                  : "border-input bg-background hover:bg-accent/50"
              }`}
            >
              <span className="block text-[11px] font-medium">
                {t(`preferences.behavior.styles.${value}.label`)}
              </span>
              <span className="block text-[10px] leading-tight text-muted-foreground">
                {t(`preferences.behavior.styles.${value}.hint`)}
              </span>
            </button>
          )
        })}
      </div>

      <textarea
        value={persona.note}
        onChange={(e) => update({ persona: { ...persona, note: e.target.value } })}
        maxLength={PERSONA_NOTE_MAX}
        rows={2}
        placeholder={t("preferences.behavior.notePlaceholder")}
        className="mt-3 w-full resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-xs leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-ring focus:ring-1 focus:ring-ring"
      />
      <div className="mt-1 flex items-start justify-between gap-2">
        <p className="text-[10px] leading-tight text-muted-foreground/70">
          {t("preferences.behavior.noteHint")}
        </p>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
          {PERSONA_NOTE_MAX - persona.note.length}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setShowPrompt((v) => !v)}
        className="mt-2 text-[11px] text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
      >
        {t("preferences.behavior.showPrompt")}
      </button>
      {showPrompt && (
        <>
          <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
            {exact || t("preferences.behavior.promptEmpty")}
          </pre>
          <p className="mt-1 text-[10px] leading-tight text-muted-foreground/60">
            {t("preferences.behavior.promptHint")}
          </p>
        </>
      )}
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

      {/* Opções que valem para o app inteiro vêm antes das abas por tipo de conversa. */}
      <LanguageSection />
      <BehaviorSection />
      <GeneralSettings />

      <div className="border-t pt-4">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("preferences.byMode")}</p>
        <SegmentedControl
          options={[
            { value: "chat" as const, label: t("preferences.tabChat") },
            { value: "code" as const, label: t("preferences.tabCode") },
          ]}
          value={tab}
          onChange={(v) => setTab(v as PrefsTab)}
          className="w-full"
        />
      </div>

      {tab === "chat" ? <ChatPrefs /> : <CodePrefs />}
    </div>
  )
}
