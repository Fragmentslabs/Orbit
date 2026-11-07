import { X } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { FragmentManifest } from "@shared/fragments"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import {
  CapabilitiesSection,
  DatabaseSection,
  HistorySection,
  OriginSection,
  PackagesSection,
  SettingsSection,
  TokensSection,
  WeightSection,
} from "./details/details-sections"
import { useFragmentDetails } from "./details/use-fragment-details"

/**
 * The details of the open fragment, docked on the right and opened from the app header:
 * what it weighs, how it is set, what it asked for and what was allowed, what its chats
 * spent, what it saved, its packages and where it came from. Read-only, except the
 * person's own allow/revoke of a capability.
 */
export function FragmentDetailsPanel({ manifest }: { manifest: FragmentManifest }) {
  const { t } = useTranslation()
  const toggle = useFragmentsStore((s) => s.toggleDetails)
  const details = useFragmentDetails(manifest.id)

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-80 max-w-full flex-col border-l border-border bg-background shadow-xl">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 px-4">
        <h2 className="text-sm font-medium">{t("fragments.details.title")}</h2>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={toggle}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SettingsSection manifest={manifest} />
        <CapabilitiesSection manifest={manifest} />
        {details && (
          <>
            <WeightSection details={details} />
            <TokensSection details={details} />
            <DatabaseSection details={details} fragmentId={manifest.id} />
            <HistorySection fragmentId={manifest.id} />
            <PackagesSection details={details} />
            <OriginSection details={details} />
          </>
        )}
      </div>
    </aside>
  )
}
