import { useTranslation } from "react-i18next"
import { isUserProfileId } from "@shared/agents"
import type { ProfileId } from "@shared/chat"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useAgentLookup, useAgentsStore, useIsTemporary } from "@/src/stores/agents-store"
import { agentView } from "@/src/components/agent-meta"
import { ProfileView } from "./profile-view"
import { SaveTemporary } from "./save-temporary"

/** The read-only view of what a profile injects, for the badge of a chat and the page's cards. */
export function ProfileDialog({ profile, open, onOpenChange }: { profile: ProfileId; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const agents = useAgentLookup()
  const temporary = useIsTemporary(profile)
  const builtins = useAgentsStore((s) => s.builtins)
  const described = useAgentsStore((s) => s.described)
  const view = agentView(profile, agents, t)
  const description = described[profile] ?? builtins.find((b) => b.id === profile)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: "44rem" }}>
        <DialogHeader>
          <DialogTitle className="pr-6 text-sm font-medium">{view?.name}</DialogTitle>
          <DialogDescription className="text-xs">{t("specialists.view.subtitle")}</DialogDescription>
        </DialogHeader>
        <div className="@container flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
          {temporary && isUserProfileId(profile) && <SaveTemporary id={profile} onSaved={() => onOpenChange(false)} />}
          {description && <ProfileView description={description} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}
