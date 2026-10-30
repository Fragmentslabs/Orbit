import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon, FolderGit2, FolderOpenIcon } from "lucide-react"
import type { LocalWorktrees } from "@shared/app-settings"
import type { ValidateWorktreesFolder } from "@shared/worktrees"
import { SettingRow, SettingSelect } from "@/src/components/settings-row"
import { worktreeApi } from "@/src/lib/ipc"
import { useAppSettings } from "@/src/stores/app-settings"
import { Truncate } from "@/components/ui/truncated-text"

async function chooseFolder(): Promise<string | null> {
  try {
    return (await window.ipcRenderer.invoke("select-folder")) as string | null
  } catch {
    return null
  }
}

/**
 * Preferences → code mode: where the worktrees created by Orbit (chats and
 * pipeline tasks) live. It only affects new ones — the existing ones stay
 * where they are, because git keeps the path of each one.
 */
export function WorktreeSettings() {
  const { t } = useTranslation()
  const worktrees = useAppSettings((s) => s.settings.worktrees)
  const update = useAppSettings((s) => s.update)
  const [validation, setValidation] = useState<ValidateWorktreesFolder | null>(null)
  const [rejected, setRejected] = useState<string | null>(null)

  /**
   * A folder inside a repository is refused: the worktrees would enter its
   * searches and status, and whoever wants that has the "Inside the project" option
   * (which takes the folder out of git by itself).
   */
  const applyFolder = async (folder: string) => {
    const result = await worktreeApi.validateFolder(folder)
    if (result.insideRepository) {
      setRejected(folder)
      return
    }
    setRejected(null)
    update({ worktrees: { local: "custom", folder } })
  }

  // It checks the custom folder whenever it changes (and on opening, because the
  // disk may have been disconnected since the choice).
  useEffect(() => {
    if (worktrees.local !== "custom" || !worktrees.folder) {
      setValidation(null)
      return
    }
    let alive = true
    void worktreeApi.validateFolder(worktrees.folder).then((result) => alive && setValidation(result))
    return () => {
      alive = false
    }
  }, [worktrees.local, worktrees.folder])

  const changeLocation = async (local: LocalWorktrees) => {
    setRejected(null)
    if (local !== "custom") {
      update({ worktrees: { local, folder: worktrees.folder } })
      return
    }
    // A custom one without a folder has nowhere to go: it chooses on the spot; cancelling
    // keeps what was there.
    const folder = worktrees.folder ?? (await chooseFolder())
    if (folder) await applyFolder(folder)
  }

  const changeFolder = async () => {
    const folder = await chooseFolder()
    if (folder) await applyFolder(folder)
  }

  return (
    <div className="space-y-2">
      <SettingRow icon={FolderGit2} title={t("worktreeSettings.title")} description={t("worktreeSettings.description")}>
        <SettingSelect<LocalWorktrees>
          value={worktrees.local}
          onChange={(v) => void changeLocation(v)}
          options={[
            { value: "default", label: t("worktreeSettings.default") },
            { value: "project", label: t("worktreeSettings.project") },
            { value: "custom", label: t("worktreeSettings.custom") },
          ]}
        />
      </SettingRow>

      <p className="px-1 text-[11px] leading-tight text-muted-foreground">
        {worktrees.local === "default"
          ? t("worktreeSettings.hintDefault")
          : worktrees.local === "project"
            ? t("worktreeSettings.hintProject")
            : t("worktreeSettings.hintCustom")}
      </p>

      {rejected && (
        <div className="px-1">
          <Notice text={t("worktreeSettings.rejectedRepository", { folder: rejected })} />
        </div>
      )}

      {worktrees.local === "custom" && worktrees.folder && (
        <div className="space-y-1.5 px-1">
          <div className="flex items-center gap-2">
            <Truncate text={worktrees.folder}>
              <span className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px]" >
                {worktrees.folder}
              </span>
            </Truncate>
            <button
              type="button"
              onClick={() => void changeFolder()}
              className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-accent"
            >
              <FolderOpenIcon className="size-3" />
              {t("worktreeSettings.choose")}
            </button>
          </div>
          {validation && !validation.exists && <Notice text={t("worktreeSettings.doesNotExist")} />}
          {validation?.insideRepository && <Notice text={t("worktreeSettings.insideRepository")} />}
          {validation?.otherDisk && <Notice text={t("worktreeSettings.otherDrive")} />}
        </div>
      )}
    </div>
  )
}

function Notice({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2 py-1.5 text-[11px] text-yellow-700 dark:text-yellow-300">
      <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
      {text}
    </p>
  )
}
