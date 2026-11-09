import { useTranslation } from "react-i18next"
import { ShieldAlert } from "lucide-react"
import { isUntrusted } from "@shared/fragment-provenance"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { useFragmentProvenance } from "../details/fragment-provenance-view"

/**
 * Shown over an imported fragment until the person reviews it. It does not block the page
 * (the code already runs with nothing allowed); it says why nothing can be granted yet and
 * takes the person to the details, where the review is confirmed.
 */
export function FragmentUntrustedBanner({ fragmentId }: { fragmentId: string }) {
  const { t } = useTranslation()
  const provenance = useFragmentProvenance(fragmentId)
  const detailsOpen = useFragmentsStore((s) => s.detailsOpen)
  const toggleDetails = useFragmentsStore((s) => s.toggleDetails)
  if (!provenance || !isUntrusted(provenance)) return null
  return (
    <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs text-amber-800 backdrop-blur dark:text-amber-200">
      <ShieldAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t("fragments.share.untrustedBanner")}</span>
      {!detailsOpen && (
        <button type="button" onClick={toggleDetails} className="shrink-0 underline">
          {t("fragments.share.review")}
        </button>
      )}
    </div>
  )
}
