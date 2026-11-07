import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ExternalLink } from "lucide-react"
import { safeSourceLink } from "@shared/fragment-provenance"
import type { FragmentProvenance } from "@shared/fragment-provenance"
import { appSettingsApi, fragmentApi } from "@/src/lib/ipc"
import { DetailRow } from "./details-section"

/** The provenance record of a fragment: where it came from, as Orbit recorded it (never as the package says). */
export function useFragmentProvenance(fragmentId: string): FragmentProvenance | null {
  const [provenance, setProvenance] = useState<FragmentProvenance | null>(null)
  useEffect(() => {
    let live = true
    const read = () => void fragmentApi.provenance(fragmentId).then((p) => live && setProvenance(p))
    read()
    // An edit of a third-party fragment marks it "changed since it arrived".
    const off = fragmentApi.onUpdated((e) => e.fragmentId === fragmentId && read())
    return () => {
      live = false
      off()
    }
  }, [fragmentId])
  return provenance
}

export function FragmentProvenanceView({ provenance }: { provenance: FragmentProvenance }) {
  const { t, i18n } = useTranslation()
  const date = new Date(provenance.recordedAt).toLocaleDateString(i18n.language)

  if (provenance.origin === "local") {
    return <DetailRow label={t("fragments.provenance.local")} value={t("fragments.provenance.recordedAt", { date })} />
  }

  const link = safeSourceLink(provenance.sourceUrl)
  return (
    <>
      <DetailRow label={t("fragments.provenance.thirdParty")} value={t("fragments.provenance.recordedAt", { date })} />
      <DetailRow
        label={t("fragments.provenance.owner")}
        value={provenance.owner ?? t("fragments.provenance.importedFile")}
      />
      {link && (
        <DetailRow
          label={t("fragments.provenance.source")}
          value={
            <button
              type="button"
              onClick={() => appSettingsApi.openExternal(link)}
              className="inline-flex max-w-full items-center gap-1 truncate text-primary hover:underline"
            >
              <span className="truncate">{link}</span>
              <ExternalLink className="size-3 shrink-0" />
            </button>
          }
        />
      )}
      <DetailRow label={t("fragments.provenance.arrival")} value={t(`fragments.provenance.arrivals.${provenance.arrival}`)} />
      {provenance.commit && <DetailRow label={t("fragments.provenance.commit")} value={<code>{provenance.commit.slice(0, 12)}</code>} />}
      {provenance.modifiedAt && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{t("fragments.provenance.modified")}</p>}
    </>
  )
}
