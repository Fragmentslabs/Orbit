import { useTranslation } from "react-i18next"
import { agentIdOf, describeUserAgent, isUserProfileId } from "@shared/agents"
import type { ProfileId } from "@shared/chat"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useAgents, useAgentsStore } from "@/src/stores/agents-store"
import { agentView } from "@/src/components/agent-meta"
import { ProfileView } from "./profile-view"

/** The read-only view of what a profile injects, for the badge of a chat and the page's cards. */
export function ProfileDialog({ profile, open, onOpenChange }: { profile: ProfileId; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const agents = useAgents()
  const builtins = useAgentsStore((s) => s.builtins)
  const view = agentView(profile, agents, t)
  const agent = isUserProfileId(profile) ? agents.find((a) => a.id === agentIdOf(profile)) : undefined
  const description = agent ? describeUserAgent(agent) : builtins.find((b) => b.id === profile)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: "44rem" }}>
        <DialogHeader>
          <DialogTitle className="pr-6 text-sm font-medium">{view?.name}</DialogTitle>
          <DialogDescription className="text-xs">{t("specialists.view.subtitle")}</DialogDescription>
        </DialogHeader>
        <div className="@container max-h-[65vh] overflow-y-auto pr-1">{description && <ProfileView description={description} />}</div>
      </DialogContent>
    </Dialog>
  )
}
