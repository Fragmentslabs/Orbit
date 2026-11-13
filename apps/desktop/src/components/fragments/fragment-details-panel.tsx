import { useState } from "react"
import { Database, History, Share, ShieldAlert, ShieldCheck, Sparkles, Trash2, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { isUntrusted } from "@shared/fragment-provenance"
import type { FragmentManifest } from "@shared/fragments"
import { Button } from "@/components/ui/button"
import { DeleteFragmentDialog } from "@/src/components/fragment-tab"
import { fragmentApi } from "@/src/lib/ipc"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import {
  DetailsDisclosure,
  ModelDetails,
  NotificationsDisclosure,
  OriginText,
  PackagesDisclosure,
  PermissionsList,
  PinsDisclosure,
  UsageDisclosure,
  WeightDisclosure,
  WidgetsDisclosure,
} from "./details/details-sections"
import { FragmentDataView } from "./details/fragment-data-view"
import { FragmentHistoryView } from "./details/fragment-history-view"
import { useFragmentDetails } from "./details/use-fragment-details"
import { KIND_META } from "./kind-meta"

/**
 * The details of the open fragment, floating over it on the right like the app's sidebar:
 * the type and revision in the header, then one column of cards — from what it is allowed to
 * do down to where it came from. No tabs: the cards are the only navigation. Read-only,
 * except the person's own allow/revoke of a capability, the pins and the undo of a turn.
 */
export function FragmentDetailsPanel({ manifest }: { manifest: FragmentManifest }) {
  const { t } = useTranslation()
  const toggle = useFragmentsStore((s) => s.toggleDetails)
  const details = useFragmentDetails(manifest.id)
  const kind = KIND_META[manifest.kind]
  const KindIcon = kind.icon
  const locked = details ? isUntrusted(details.provenance) : false
  const granted = manifest.requests.filter((cap) => manifest.grants.includes(cap)).length
  const pending = granted < manifest.requests.length
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <aside
      aria-label={t("fragments.details.title")}
      className="absolute top-2 right-2 bottom-2 z-30 flex w-80 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-lg bg-sidebar text-sidebar-foreground shadow-sm ring-1 ring-sidebar-border"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-sidebar-border/60 px-3">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground">
          <KindIcon className="size-3.5" />
        </span>
        <h2 className="min-w-0 truncate text-sm font-medium">{t(kind.name)}</h2>
        <span className="shrink-0 rounded-full border border-sidebar-border px-1.5 py-px text-[10px] tabular-nums text-muted-foreground">
          {t("fragments.details.revisionShort", { revision: manifest.revision })}
        </span>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={toggle}
          className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {locked && (
          <div className="flex items-start gap-2 border-b border-sidebar-border/60 bg-sidebar-accent/40 px-3 py-2">
            <ShieldAlert className="mt-px size-3.5 shrink-0 text-muted-foreground" />
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t("fragments.share.lockedHint")}
            </p>
          </div>
        )}

        <DetailsDisclosure
          icon={ShieldCheck}
          label={t("fragments.details.permissions")}
          value={manifest.requests.length ? granted : undefined}
          defaultOpen={locked || pending}
        >
          <PermissionsList manifest={manifest} locked={locked} />
        </DetailsDisclosure>

        {manifest.requests.includes("notify") && (
          <NotificationsDisclosure fragmentId={manifest.id} />
        )}

        {manifest.requests.includes("ai") && manifest.grants.includes("ai") && (
          <DetailsDisclosure
            icon={Sparkles}
            label={t("fragments.details.model")}
            value={manifest.model?.modelId ?? t("fragments.modelFollowChat")}
          >
            <ModelDetails manifest={manifest} />
          </DetailsDisclosure>
        )}

        {manifest.widgets.length > 0 && <WidgetsDisclosure manifest={manifest} />}

        {details && details.tokens.chats > 0 && <UsageDisclosure details={details} />}
        {details && <WeightDisclosure details={details} />}
        {details && details.packages.length > 0 && <PackagesDisclosure details={details} />}

        <DetailsDisclosure
          icon={Database}
          label={t("fragments.details.dataSaved")}
          contentClassName="p-0"
        >
          <FragmentDataView fragmentId={manifest.id} embedded />
        </DetailsDisclosure>

        <DetailsDisclosure
          icon={History}
          label={t("fragments.details.tabHistory")}
          value={manifest.revision}
          contentClassName="p-0"
        >
          <FragmentHistoryView fragmentId={manifest.id} />
        </DetailsDisclosure>

        <PinsDisclosure manifest={manifest} />

        {details && (
          <div className="px-3 pt-2 pb-4">
            <OriginText provenance={details.provenance} fragmentId={manifest.id} />
          </div>
        )}
      </div>

      {/* What used to be in the header's menu: taking the file out and removing the fragment. */}
      <footer className="flex shrink-0 items-center gap-1.5 border-t border-sidebar-border/60 p-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 flex-1 justify-center gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-sidebar-foreground"
          onClick={() => void fragmentApi.exportFile(manifest.id)}
        >
          <Share className="size-3.5" />
          {t("fragments.share.export")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 justify-center gap-1.5 px-2 text-[11px] text-destructive hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="size-3.5" />
          {t("fragments.delete")}
        </Button>
      </footer>

      <DeleteFragmentDialog open={confirmDelete} onOpenChange={setConfirmDelete} fragmentId={manifest.id} />
    </aside>
  )
}
