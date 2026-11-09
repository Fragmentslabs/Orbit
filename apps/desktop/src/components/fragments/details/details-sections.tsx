import { useState } from "react"
import { useTranslation } from "react-i18next"
import { FRAGMENT_CAPABILITIES } from "@shared/fragments"
import type { FragmentDetails } from "@shared/fragment-details"
import type { FragmentManifest } from "@shared/fragments"
import { Button } from "@/components/ui/button"
import { formatBytes, formatCost, formatTokens } from "@/src/lib/format"
import { fragmentApi } from "@/src/lib/ipc"
import { describeAccess } from "../access-text"
import { KIND_META } from "../kind-meta"
import { DetailRow, DetailsSection } from "./details-section"
import { FragmentDataDialog } from "./fragment-data-dialog"
import { FragmentHistoryDialog } from "./fragment-history-dialog"
import { FragmentProvenanceView } from "./fragment-provenance-view"

/** The sections of the details panel, one small component each. */

export function WeightSection({ details }: { details: FragmentDetails }) {
  const { t } = useTranslation()
  return (
    <DetailsSection title={t("fragments.details.weight")}>
      <DetailRow label={t("fragments.details.code")} value={formatBytes(details.srcBytes)} />
      <DetailRow label={t("fragments.details.data")} value={formatBytes(details.dataBytes)} />
      <DetailRow label={t("fragments.details.history")} value={formatBytes(details.historyBytes)} />
      <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        {details.files.map((f) => (
          <li key={f.path} className="flex justify-between gap-3">
            <span className="truncate">{f.path}</span>
            <span className="shrink-0">{formatBytes(f.bytes)}</span>
          </li>
        ))}
      </ul>
    </DetailsSection>
  )
}

export function SettingsSection({ manifest }: { manifest: FragmentManifest }) {
  const { t } = useTranslation()
  const model = manifest.model ? `${manifest.model.modelId}` : t("fragments.modelFollowChat")
  return (
    <DetailsSection title={t("fragments.details.settings")}>
      <DetailRow label={t("fragments.kindLabel")} value={t(KIND_META[manifest.kind].name)} />
      <DetailRow label={t("fragments.details.model")} value={model} />
      <DetailRow
        label={t("fragments.details.thinking")}
        value={manifest.reasoning?.enabled ? (manifest.reasoning.variantId ?? t("fragments.details.on")) : t("fragments.details.off")}
      />
      <DetailRow label={t("fragments.details.pins")} value={pinsLabel(manifest, t)} />
      <DetailRow label={t("fragments.details.revision")} value={manifest.revision} />
    </DetailsSection>
  )
}

function pinsLabel(manifest: FragmentManifest, t: (key: string) => string): string {
  const where = [
    manifest.pinned.sidebar && t("fragments.details.pinSidebar"),
    manifest.pinned.panel && t("fragments.details.pinPanel"),
    manifest.pinned.home && t("fragments.details.pinHome"),
  ].filter(Boolean)
  return where.length ? where.join(", ") : t("fragments.details.none")
}

/** What the fragment asked for and what the person allowed. Only the person's click grants. */
/** `locked`: an imported fragment nobody reviewed — turning things on waits for the review. */
export function CapabilitiesSection({ manifest, locked = false }: { manifest: FragmentManifest; locked?: boolean }) {
  const { t } = useTranslation()
  return (
    <DetailsSection title={t("fragments.details.capabilities")}>
      {FRAGMENT_CAPABILITIES.map((cap) => {
        const asked = manifest.requests.includes(cap)
        const granted = manifest.grants.includes(cap)
        return (
          <div key={cap} className="flex items-center justify-between gap-3">
            <span className="text-foreground">
              {t(`fragments.details.cap.${cap}`)}
              {asked && (cap === "http" || cap === "mcp") && (
                <span className="block break-words text-[11px] text-muted-foreground">{describeAccess(manifest, cap)}</span>
              )}
            </span>
            {asked ? (
              <Button
                size="sm"
                variant={granted ? "secondary" : "outline"}
                className="h-6 px-2 text-[11px]"
                disabled={locked && !granted}
                title={locked && !granted ? t("fragments.share.lockedHint") : undefined}
                onClick={() => void fragmentApi.grant(manifest.id, cap, !granted)}
              >
                {granted ? t("fragments.details.allowed") : t("fragments.details.allow")}
              </Button>
            ) : (
              <span className="text-muted-foreground">{t("fragments.details.notRequested")}</span>
            )}
          </div>
        )
      })}
    </DetailsSection>
  )
}

export function TokensSection({ details }: { details: FragmentDetails }) {
  const { t } = useTranslation()
  const { tokens } = details
  return (
    <DetailsSection title={t("fragments.details.tokens")}>
      <DetailRow label={t("fragments.details.chats")} value={tokens.chats} />
      <DetailRow label={t("fragments.details.input")} value={formatTokens(tokens.input)} />
      <DetailRow label={t("fragments.details.output")} value={formatTokens(tokens.output)} />
      {tokens.cost > 0 && <DetailRow label={t("fragments.details.cost")} value={formatCost(tokens.cost)} />}
    </DetailsSection>
  )
}

export function DatabaseSection({ details, fragmentId }: { details: FragmentDetails; fragmentId: string }) {
  const { t } = useTranslation()
  const [viewing, setViewing] = useState(false)
  return (
    <DetailsSection title={t("fragments.details.database")}>
      {details.dataKeys.length === 0 && <span className="text-muted-foreground">{t("fragments.details.databaseEmpty")}</span>}
      {details.dataKeys.map((k) => (
        <DetailRow key={k.key} label={k.key} value={formatBytes(k.bytes)} />
      ))}
      <Button size="sm" variant="outline" className="mt-1 h-7 self-start text-xs" onClick={() => setViewing(true)}>
        {t("fragments.data.view")}
      </Button>
      <FragmentDataDialog fragmentId={fragmentId} open={viewing} onOpenChange={setViewing} />
    </DetailsSection>
  )
}

export function PackagesSection({ details }: { details: FragmentDetails }) {
  const { t } = useTranslation()
  return (
    <DetailsSection title={t("fragments.details.packages")}>
      {details.packages.length === 0 && <span className="text-muted-foreground">{t("fragments.details.packagesEmpty")}</span>}
      {details.packages.map((p) => (
        <DetailRow key={p.name} label={p.name} value={p.version} />
      ))}
    </DetailsSection>
  )
}

export function OriginSection({ details, fragmentId }: { details: FragmentDetails; fragmentId: string }) {
  const { t } = useTranslation()
  return (
    <DetailsSection title={t("fragments.provenance.title")}>
      <FragmentProvenanceView provenance={details.provenance} fragmentId={fragmentId} />
    </DetailsSection>
  )
}

/** The agent's writes, turn by turn, with the person's way back. */
export function HistorySection({ fragmentId }: { fragmentId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <DetailsSection title={t("fragments.history.title")}>
      <span className="text-muted-foreground">{t("fragments.history.hint")}</span>
      <Button size="sm" variant="outline" className="mt-1 h-7 self-start text-xs" onClick={() => setOpen(true)}>
        {t("fragments.history.open")}
      </Button>
      <FragmentHistoryDialog fragmentId={fragmentId} open={open} onOpenChange={setOpen} />
    </DetailsSection>
  )
}
