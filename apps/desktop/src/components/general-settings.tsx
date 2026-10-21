import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Archive, FoldVertical, LayoutList, Lightbulb, Minimize2, RotateCw, Rocket, StepForward, Trash2, UserRound } from "lucide-react"
import { AUTO_ARCHIVE_DAY_OPTIONS, DELETE_ARCHIVED_DAY_OPTIONS, type AutoCompactMode, type ChatViewMode } from "@shared/app-settings"
import { USER_NAME_MAX } from "@shared/user-name"
import { ModelField } from "@/src/components/model-field"
import { SettingRow, SettingSelect, SettingSwitch } from "@/src/components/settings-row"
import { useAppSettings } from "@/src/stores/app-settings"
import { ThinkingMenu } from "@/src/components/thinking-menu"
import { windowApi } from "@/src/lib/ipc"

/** Raciocínio do modelo auxiliar: o mesmo botão dos outros modelos das Preferências. */
function AuxThinkingMenu() {
  const auxModel = useAppSettings((s) => s.settings.auxModel)
  const auxReasoning = useAppSettings((s) => s.settings.auxReasoning)
  const update = useAppSettings((s) => s.update)
  return <ThinkingMenu model={auxModel} value={auxReasoning} onChange={(next) => update({ auxReasoning: next })} />
}

/**
 * Nome com que o Orbit chama o usuário. O agente aprende na conversa; este
 * campo é a saída para corrigir ou apagar. Grava ao sair do campo (ou Enter),
 * não a cada tecla — não há motivo para empurrar 40 mudanças ao main.
 */
function UserNameField() {
  const { t } = useTranslation()
  const userName = useAppSettings((s) => s.settings.userName)
  const update = useAppSettings((s) => s.update)
  const [draft, setDraft] = useState(userName ?? "")

  // O agente pode aprender o nome com esta tela aberta.
  useEffect(() => setDraft(userName ?? ""), [userName])

  return (
    <SettingRow
      icon={UserRound}
      title={t("preferences.general.name.title")}
      description={t("preferences.general.name.description")}
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => update({ userName: draft })}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
        }}
        placeholder={t("preferences.general.name.placeholder")}
        maxLength={USER_NAME_MAX}
        aria-label={t("preferences.general.name.title")}
        className="h-8 w-44 rounded-md border border-input bg-transparent px-2.5 text-xs outline-none transition-colors focus-visible:border-ring"
      />
    </SettingRow>
  )
}

const COUNT_OPTIONS = [0, 1, 2, 3, 5] as const

export function GeneralSettings() {
  const { t } = useTranslation()
  const settings = useAppSettings((s) => s.settings)
  const update = useAppSettings((s) => s.update)
  const isMac = windowApi.platform === "darwin"

  const countOptions = COUNT_OPTIONS.map((n) => ({
    value: String(n),
    label: n === 0 ? t("preferences.general.off") : t("preferences.general.times", { count: n }),
  }))

  return (
    <div className="flex flex-col gap-3">
      <UserNameField />

      <div>
        <ModelField
          label={t("preferences.general.auxModel")}
          value={settings.auxModel}
          nullLabel={t("preferences.general.auxModelNone")}
          // Outro modelo, outros níveis: o raciocínio volta a desligado em vez
          // de herdar um nível que talvez nem exista nele.
          onChange={(auxModel) => update({ auxModel, auxReasoning: null })}
          action={<AuxThinkingMenu />}
        />
        <p className="mt-1 text-[11px] leading-tight text-muted-foreground">{t("preferences.general.auxModelHint")}</p>
      </div>

      <SettingRow
        icon={Lightbulb}
        title={t("preferences.general.suggestions.title")}
        description={t("preferences.general.suggestions.description")}
      >
        <SettingSwitch
          checked={settings.promptSuggestions}
          onChange={(promptSuggestions) => update({ promptSuggestions })}
          label={t("preferences.general.suggestions.title")}
        />
      </SettingRow>

      <SettingRow
        icon={LayoutList}
        title={t("preferences.general.view.title")}
        description={t(`preferences.general.view.hint.${settings.chatView}`)}
      >
        <SettingSelect<ChatViewMode>
          value={settings.chatView}
          onChange={(chatView) => update({ chatView })}
          options={(["summary", "steps", "detailed"] as const).map((value) => ({
            value,
            label: t(`preferences.general.view.${value}`),
          }))}
        />
      </SettingRow>

      <SettingRow
        icon={Archive}
        title={t("preferences.general.archive.title")}
        description={t("preferences.general.archive.description")}
      >
        <SettingSelect
          value={settings.autoArchiveDays ? String(settings.autoArchiveDays) : "off"}
          onChange={(v) => update({ autoArchiveDays: v === "off" ? null : Number(v) })}
          options={[
            { value: "off", label: t("preferences.general.off") },
            ...AUTO_ARCHIVE_DAY_OPTIONS.map((days) => ({
              value: String(days),
              label: t("preferences.general.archive.after", { count: days }),
            })),
          ]}
        />
      </SettingRow>

      <SettingRow
        icon={Trash2}
        title={t("preferences.general.deleteArchived.title")}
        description={t("preferences.general.deleteArchived.description")}
      >
        <SettingSelect
          value={settings.deleteArchivedDays ? String(settings.deleteArchivedDays) : "off"}
          onChange={(v) => update({ deleteArchivedDays: v === "off" ? null : Number(v) })}
          options={[
            { value: "off", label: t("preferences.general.off") },
            ...DELETE_ARCHIVED_DAY_OPTIONS.map((days) => ({
              value: String(days),
              label: t("preferences.general.archive.after", { count: days }),
            })),
          ]}
        />
      </SettingRow>

      <SettingRow
        icon={FoldVertical}
        title={t("preferences.general.compact.title")}
        description={t("preferences.general.compact.description")}
      >
        <SettingSelect<AutoCompactMode>
          value={settings.autoCompact}
          onChange={(autoCompact) => update({ autoCompact })}
          options={(["auto", "75", "50"] as const).map((value) => ({
            value,
            label: t(`preferences.general.compact.${value}`),
          }))}
        />
      </SettingRow>

      <SettingRow
        icon={RotateCw}
        title={t("preferences.general.retries.title")}
        description={t("preferences.general.retries.description")}
      >
        <SettingSelect
          value={String(settings.transientRetries)}
          onChange={(v) => update({ transientRetries: Number(v) })}
          options={countOptions}
        />
      </SettingRow>

      <SettingRow
        icon={StepForward}
        title={t("preferences.general.continues.title")}
        description={t("preferences.general.continues.description")}
      >
        <SettingSelect
          value={String(settings.autoContinues)}
          onChange={(v) => update({ autoContinues: Number(v) })}
          options={countOptions}
        />
      </SettingRow>

      <SettingRow
        icon={Rocket}
        title={t("preferences.general.launchAtLogin.title")}
        description={t("preferences.general.launchAtLogin.description")}
      >
        <SettingSwitch
          checked={settings.launchAtLogin}
          onChange={(launchAtLogin) => update({ launchAtLogin })}
          label={t("preferences.general.launchAtLogin.title")}
        />
      </SettingRow>

      {/* No macOS não há bandeja — fechar já deixa o app vivo no Dock —, então
          a preferência não teria o que governar lá. */}
      {!isMac && (
        <SettingRow
          icon={Minimize2}
          title={t("preferences.general.closeToTray.title")}
          description={t("preferences.general.closeToTray.description")}
        >
          <SettingSwitch
            checked={settings.closeToTray}
            onChange={(closeToTray) => update({ closeToTray })}
            label={t("preferences.general.closeToTray.title")}
          />
        </SettingRow>
      )}
    </div>
  )
}
