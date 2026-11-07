import { Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { ArtifactRef } from "@shared/artifacts"
import { useArtifactActivity } from "@/src/hooks/use-artifact-activity"

/**
 * Where an artifact lists itself (a sidebar row, a card): a spinner while a chat is working
 * on it, and a bullet once it finished and the person has not looked yet. The same for every
 * kind of artifact; renders nothing when there is nothing to say.
 */
export function ArtifactActivity({ artifact }: { artifact: ArtifactRef }) {
  const { t } = useTranslation()
  const { working, unread } = useArtifactActivity(artifact)
  if (working) return <Loader2 aria-label={t("artifact.working")} className="size-3 shrink-0 animate-spin text-primary" />
  if (unread) return <span title={t("artifact.done")} className="size-2 shrink-0 rounded-full bg-primary" />
  return null
}
