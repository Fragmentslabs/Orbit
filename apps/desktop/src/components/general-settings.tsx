import { useTranslation } from "react-i18next"
import { Archive, FoldVertical, LayoutList, Lightbulb, RotateCw, StepForward, Trash2 } from "lucide-react"
import { AUTO_ARCHIVE_DAY_OPTIONS, DELETE_ARCHIVED_DAY_OPTIONS, type AutoCompactMode, type ChatViewMode } from "@shared/app-settings"
import { ModelField } from "@/src/components/model-field"
import { SettingRow, SettingSelect, SettingSwitch } from "@/src/components/settings-row"
import { useAppSettings } from "@/src/stores/app-settings"
import { ThinkingMenu } from "@/src/components/thinking-menu"

/** Raciocínio do modelo auxiliar: o mesmo botão dos outros modelos das Preferências. */
function AuxThinkingMenu() {
  const auxModel = useAppSettings((s) => s.settings.auxModel)
  const auxReasoning = useAppSettings((s) => s.settings.auxReasoning)
  const update = useAppSettings((s) => s.update)
  return <ThinkingMenu model={auxModel} value={auxReasoning} onChange={(next) => update({ auxReasoning: next })} />
}

const COUNT_OPTIONS = [0, 1, 2, 3, 5] as const

export function GeneralSettings() {
  const { t } = useTranslation()
  const settings = useAppSettings((s) => s.settings)
  const update = useAppSettings((s) => s.update)

  const countOptions = COUNT_OPTIONS.map((n) => ({
    value: String(n),
    label: n === 0 ? t("preferences.general.off") : t("preferences.general.times", { count: n }),
  }))

  return (
    <div className="flex flex-col gap-3">
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
    </div>
  )
}
