import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Archive, Brain, LayoutList, Lightbulb, MessagesSquare, Minimize2, RotateCw, Rocket, StepForward, Trash2, UserRound } from "lucide-react"
import { AUTO_ARCHIVE_DAY_OPTIONS, DELETE_ARCHIVED_DAY_OPTIONS, type ChatViewMode, type MemoryRoutineMode } from "@shared/app-settings"
import { USER_NAME_MAX } from "@shared/user-name"
import { ModelField } from "@/src/components/model-field"
import { SettingRow, SettingSelect, SettingSwitch } from "@/src/components/settings-row"
import { useAppSettings } from "@/src/stores/app-settings"
import { ThinkingMenu } from "@/src/components/thinking-menu"
import { windowApi } from "@/src/lib/ipc"

/** Reasoning of the auxiliary model: the same button as the other models of Preferences. */
function AuxThinkingMenu() {
  const auxModel = useAppSettings((s) => s.settings.auxModel)
  const auxReasoning = useAppSettings((s) => s.settings.auxReasoning)
  const update = useAppSettings((s) => s.update)
  return <ThinkingMenu model={auxModel} value={auxReasoning} onChange={(next) => update({ auxReasoning: next })} />
}

/**
 * Name with which Orbit calls the user. The agent learns it in the conversation; this
 * field is the way out to correct or erase it. It saves on leaving the field (or Enter),
 * not on every key — there is no reason to push 40 changes to the main process.
 */
function UserNameField() {
  const { t } = useTranslation()
  const userName = useAppSettings((s) => s.settings.userName)
  const update = useAppSettings((s) => s.update)
  const [draft, setDraft] = useState(userName ?? "")

  // The agent may learn the name with this screen open.
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
          // Another model, other levels: the reasoning goes back to off instead
          // of inheriting a level that may not even exist in it.
          onChange={(auxModel) => update({ auxModel, auxReasoning: null })}
          action={<AuxThinkingMenu />}
        />
        <p className="mt-1 text-[11px] leading-tight text-muted-foreground">{t("preferences.general.auxModelHint")}</p>
      </div>

      <SettingRow
        icon={Brain}
        title={t("preferences.general.memoryRoutine.title")}
        description={
          settings.auxModel
            ? t("preferences.general.memoryRoutine.description", { model: settings.auxModel.modelId })
            : t("preferences.general.memoryRoutine.needsModel")
        }
      >
        <SettingSelect<MemoryRoutineMode>
          value={settings.memoryRoutine}
          onChange={(memoryRoutine) => update({ memoryRoutine })}
          options={(
            [
              ["off", "off"],
              ["daily", "daily"],
              ["weekly", "weekly"],
              ["daily+weekly", "dailyWeekly"],
            ] as const
          ).map(([value, key]) => ({ value, label: t(`memories.routine.${key}`) }))}
        />
      </SettingRow>

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

      {/* Compaction has no option: it is automatic, at the model's limit, and the
          manual one lives in the composer's context meter. A percentage of the window
          was a decision nobody could calibrate — at 50% it summarized with plenty of
          room left and degraded the conversation faster. */}
      <SettingRow
        icon={MessagesSquare}
        title={t("preferences.general.compactSuggest.title")}
        description={t("preferences.general.compactSuggest.description")}
      >
        <SettingSwitch
          checked={settings.suggestNewChat}
          onChange={(suggestNewChat) => update({ suggestNewChat })}
          label={t("preferences.general.compactSuggest.title")}
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

      {/* On macOS there is no tray — closing already leaves the app alive in the Dock —, so
          the preference would have nothing to rule there. */}
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
