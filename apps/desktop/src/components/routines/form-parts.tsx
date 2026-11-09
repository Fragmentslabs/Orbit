import { useTranslation } from "react-i18next"
import { userProfileId } from "@shared/agents"
import type { ProfileId } from "@shared/chat"
import type { RoutineModes } from "@shared/routines"
import { modesFromAgentFeatures, ROUTINE_CHAT_MODES, ROUTINE_MODES } from "@shared/routines"
import { FolderSelector } from "@/src/components/folder-selector"
import { useAgents } from "@/src/stores/agents-store"
import { ModesEditor } from "./schedule-editor"

/** Parts of the routine form shared by the creation modal and the edit dialog. */

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{label}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}

/**
 * Abilities and autonomy. With an agent the abilities are the agent's (listed, not switchable);
 * without one the person picks them. The autonomy level is the routine's own either way.
 */
export function AbilitiesField({ agent, team, modes, onChange, chatOnly }: {
  agent: ProfileId | undefined
  /** A team runs the routine: its agents decide the abilities, only the autonomy is set here. */
  team?: boolean
  modes: RoutineModes
  onChange: (modes: RoutineModes) => void
  /** No folders: only the chat abilities exist. */
  chatOnly: boolean
}) {
  const { t } = useTranslation()
  const agents = useAgents()
  const selected = agent ? agents.find((a) => userProfileId(a.id) === agent) : undefined
  const given = selected ? Object.keys(modesFromAgentFeatures(selected.features)) : []
  return (
    <div className="space-y-2">
      {selected && (
        <p className="text-[11px] text-muted-foreground">
          {t("routines.form.agentGives")}{" "}
          <span className="text-foreground">
            {given.length > 0 ? given.map((key) => t(`routines.modes.${key}.name`)).join(", ") : t("routines.form.noneGiven")}
          </span>
        </p>
      )}
      <ModesEditor
        modes={modes}
        onChange={onChange}
        available={selected || team ? [] : chatOnly ? ROUTINE_CHAT_MODES : ROUTINE_MODES}
      />
    </div>
  )
}

/** Folders are optional: none means the routine runs as a chat. */
export function FoldersField({ folders, onChange }: { folders: string[]; onChange: (folders: string[]) => void }) {
  const { t } = useTranslation()
  return (
    <Field label={t("routines.form.folders")} hint={t("routines.form.foldersHint")}>
      <FolderSelector folders={folders} onFoldersChange={onChange} />
    </Field>
  )
}
