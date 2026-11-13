import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react"
import {
  Bell,
  ChevronRight,
  ExternalLink,
  Coins,
  HardDrive,
  LayoutGrid,
  Package,
  PanelRight,
  Pin,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { isUntrusted, safeSourceLink } from "@shared/fragment-provenance"
import type { FragmentProvenance } from "@shared/fragment-provenance"
import {
  FRAGMENT_CAPABILITIES,
  type FragmentManifest,
  type FragmentNotification,
} from "@shared/fragments"
import type { FragmentDetails } from "@shared/fragment-details"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { formatBytes, formatCost, formatTokens } from "@/src/lib/format"
import { appSettingsApi, fragmentApi } from "@/src/lib/ipc"
import { biggestSize, sizesLargestFirst, widgetsLargestFirst } from "@/src/lib/widget-board"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { useWidgetPanelStore } from "@/src/stores/widget-panel-store"
import { WidgetPreview } from "../widget-preview"
import { describeAccess } from "../access-text"
import { FragmentThinkingMenu } from "../fragment-header-actions"
import { FragmentModelPicker } from "../fragment-model-picker"

/**
 * The details tab is a short stack of collapsible rows, not a wall of sections: everything
 * that can be looked at is one click deep, and only what the person changes (permissions)
 * opens by itself when something is still pending.
 */

/** One collapsible row: icon, label, a short value on the right, the body behind a click. */
export function DetailsDisclosure({
  icon: Icon,
  label,
  value,
  defaultOpen = false,
  contentClassName,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value?: ReactNode
  defaultOpen?: boolean
  /** The body's padding — "p-0" for a view that already brings its own. */
  contentClassName?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-b border-sidebar-border/60 last:border-b-0"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-sidebar-accent/40">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
        {value !== undefined && value !== "" && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{value}</span>
        )}
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn("px-3 pb-3", contentClassName)}>{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** One label/value line inside a disclosure. */
function Line({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-[11.5px]">{value}</span>
    </div>
  )
}

/**
 * What the fragment asked for and what the person allowed — a switch, not an "allow" button:
 * turning it off is as easy to find as turning it on. Only the person's click grants.
 * `locked`: an imported fragment nobody reviewed — turning things on waits for the review.
 */
export function PermissionsList({
  manifest,
  locked = false,
}: {
  manifest: FragmentManifest
  locked?: boolean
}) {
  const { t } = useTranslation()
  const asked = FRAGMENT_CAPABILITIES.filter((cap) => manifest.requests.includes(cap))

  if (asked.length === 0) {
    return (
      <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
        <ShieldCheck className="mt-px size-3.5 shrink-0" />
        {t("fragments.details.permissionsEmpty")}
      </p>
    )
  }

  return (
    <ul className="flex flex-col">
      {asked.map((cap) => {
        const granted = manifest.grants.includes(cap)
        return (
          <li key={cap} className="flex items-center justify-between gap-3 py-1.5">
            <span className="min-w-0">
              <span className="block truncate text-[11.5px]">{t(`fragments.details.cap.${cap}`)}</span>
              {(cap === "http" || cap === "mcp") && (
                <span className="block break-words text-[10.5px] text-muted-foreground">
                  {describeAccess(manifest, cap)}
                </span>
              )}
            </span>
            <Switch
              checked={granted}
              disabled={locked && !granted}
              aria-label={t(`fragments.details.cap.${cap}`)}
              onCheckedChange={(on) => void fragmentApi.grant(manifest.id, cap, on)}
            />
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The schedules the fragment created with `orbit.notify` — kept by the app, so they fire with
 * the fragment closed (while Orbit is open). Only the person cancels one; the page schedules.
 */
export function useFragmentNotifications(fragmentId: string) {
  const [items, setItems] = useState<FragmentNotification[]>([])
  const [failed, setFailed] = useState(false)

  const read = useCallback(() => {
    fragmentApi
      .notifications(fragmentId)
      .then((list) => {
        setItems(list)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [fragmentId])

  useEffect(() => {
    read()
    return fragmentApi.onUpdated((e) => e.fragmentId === fragmentId && read())
  }, [fragmentId, read])

  const cancel = useCallback(
    (id: string) => {
      void fragmentApi.cancelNotification(fragmentId, id).then(read).catch(() => setFailed(true))
    },
    [fragmentId, read],
  )

  return { items, failed, cancel }
}

export function NotificationsList({
  items,
  failed,
  onCancel,
}: {
  items: FragmentNotification[]
  failed: boolean
  onCancel: (id: string) => void
}) {
  const { t, i18n } = useTranslation()

  if (failed) {
    return <p className="text-[11px] text-destructive">{t("fragments.details.notificationsError")}</p>
  }

  const when = (n: FragmentNotification): string => {
    if (n.dailyAt) return t("fragments.notify.daily", { time: n.dailyAt })
    if (n.everyMinutes) return t("fragments.notify.every", { minutes: n.everyMinutes })
    return t("fragments.notify.at", {
      date: new Date(n.nextAt).toLocaleString(i18n.language, {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    })
  }

  return (
    <div className="flex flex-col gap-1">
      {items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("fragments.details.notificationsEmpty")}</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-2 py-1">
              <span className="min-w-0">
                <span className="block truncate text-[11.5px]">{n.title}</span>
                <span className="block text-[10.5px] text-muted-foreground">{when(n)}</span>
              </span>
              <button
                type="button"
                aria-label={t("fragments.notify.cancel")}
                onClick={() => onCancel(n.id)}
                className="mt-px flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10.5px] text-muted-foreground">{t("fragments.details.notificationsHint")}</p>
    </div>
  )
}

/**
 * The model this fragment's page gets when it calls `orbit.ai`, and how much it thinks —
 * side by side: the thinking belongs to the model, and the header no longer carries either.
 */
export function ModelDetails({ manifest }: { manifest: FragmentManifest }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1">
        <FragmentModelPicker manifest={manifest} triggerClassName="h-8 w-full text-xs" />
      </div>
      {/* Right next to the model it belongs to — no label repeating what the icon already says. */}
      <FragmentThinkingMenu manifest={manifest} />
    </div>
  )
}

/**
 * Everything else: where it is pinned, what it costs, what it weighs and where it came from.
 * Each of the three is its own drawer, and the origin is a sentence — nothing here is a table.
 */
/** What this fragment spent running — hidden until it has actually run. */
export function UsageDisclosure({ details }: { details: FragmentDetails }) {
  const { t } = useTranslation()
  const { tokens } = details
  return (
    <DetailsDisclosure
      icon={Coins}
      label={t("fragments.details.usage")}
      value={tokens.cost > 0 ? formatCost(tokens.cost) : tokens.chats}
    >
      <Line label={t("fragments.details.chats")} value={tokens.chats} />
      <Line label={t("fragments.details.input")} value={formatTokens(tokens.input)} />
      <Line label={t("fragments.details.output")} value={formatTokens(tokens.output)} />
      {tokens.cost > 0 && <Line label={t("fragments.details.cost")} value={formatCost(tokens.cost)} />}
    </DetailsDisclosure>
  )
}

/** Code, saved data and history, summed up in one line of weight. */
export function WeightDisclosure({ details }: { details: FragmentDetails }) {
  const { t } = useTranslation()
  return (
    <DetailsDisclosure
      icon={HardDrive}
      label={t("fragments.details.weight")}
      value={formatBytes(details.srcBytes + details.dataBytes + details.historyBytes)}
    >
      <Line label={t("fragments.details.code")} value={formatBytes(details.srcBytes)} />
      <Line label={t("fragments.details.data")} value={formatBytes(details.dataBytes)} />
      <Line label={t("fragments.details.history")} value={formatBytes(details.historyBytes)} />
    </DetailsDisclosure>
  )
}

/** Third-party libraries the page loads — only exists when there are any. */
export function PackagesDisclosure({ details }: { details: FragmentDetails }) {
  const { t } = useTranslation()
  return (
    <DetailsDisclosure
      icon={Package}
      label={t("fragments.details.packages")}
      value={details.packages.length}
    >
      {details.packages.map((p) => (
        <Line key={p.name} label={p.name} value={p.version} />
      ))}
    </DetailsDisclosure>
  )
}

/** The three places it can live — the same toggles the actions menu carries. */
export function PinsDisclosure({ manifest }: { manifest: FragmentManifest }) {
  const { t } = useTranslation()
  return (
    <DetailsDisclosure icon={Pin} label={t("fragments.details.appears")}>
      <PinToggles manifest={manifest} />
    </DetailsDisclosure>
  )
}

/** The places a fragment can live — the same three the actions menu toggles. */
function PinToggles({ manifest }: { manifest: FragmentManifest }) {
  const { t } = useTranslation()
  const pins: { key: "sidebar" | "panel"; icon: typeof Pin; label: string }[] = [
    { key: "sidebar", icon: Pin, label: t("fragments.details.pinSidebar") },
    { key: "panel", icon: PanelRight, label: t("fragments.details.pinPanel") },
  ]

  return (
    <div className="flex flex-wrap gap-1">
      {pins.map(({ key, icon: Icon, label }) => {
        const on = manifest.pinned[key]
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            onClick={() => togglePin(manifest, key, !on)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10.5px] transition-colors",
              on
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-sidebar-border text-muted-foreground hover:text-sidebar-foreground",
            )}
          >
            <Icon className="size-2.5" />
            {label}
          </button>
        )
      })}
    </div>
  )
}

function togglePin(manifest: FragmentManifest, key: "sidebar" | "panel", on: boolean): void {
  void fragmentApi.update(manifest.id, { pinned: { [key]: on } })
}

/** The widgets this fragment offers to the board — what used to be a badge in the header. */
export function WidgetsDisclosure({ manifest }: { manifest: FragmentManifest }) {
  const { t } = useTranslation()
  const leave = useFragmentsStore((s) => s.leave)

  return (
    <DetailsDisclosure icon={LayoutGrid} label={t("fragments.details.widgets")} value={manifest.widgets.length}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2">
          {widgetsLargestFirst(manifest.widgets).map((widget) => (
            <div key={widget.id} className="flex items-center gap-2">
              <WidgetPreview
                fragment={manifest}
                widget={widget.id}
                size={biggestSize(widget)}
                unit={38}
                className="rounded-md border border-border/60"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] font-medium">{widget.name}</span>
                <span className="block truncate text-[10px] tabular-nums text-muted-foreground">
                  {sizesLargestFirst(widget).join(" · ")}
                </span>
              </span>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-full justify-center gap-1.5 text-[11px]"
          onClick={() => {
            leave()
            useWidgetPanelStore.getState().setSection("widgets")
          }}
        >
          <LayoutGrid className="size-3.5" />
          {t("fragments.details.widgetsOpen")}
        </Button>
      </div>
    </DetailsDisclosure>
  )
}

/** Where it came from, as a sentence. The review action stays when the fragment still needs one. */
export function OriginText({
  provenance,
  fragmentId,
}: {
  provenance: FragmentProvenance
  fragmentId: string
}) {
  const { t, i18n } = useTranslation()
  const date = new Date(provenance.recordedAt).toLocaleDateString(i18n.language)
  // The local variant of the record carries neither of these.
  const link = provenance.origin === "local" ? null : safeSourceLink(provenance.sourceUrl)
  const modifiedAt = provenance.origin === "local" ? undefined : provenance.modifiedAt

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] leading-snug text-muted-foreground">
        {provenance.origin === "local"
          ? t("fragments.provenance.localText", { date })
          : t("fragments.provenance.thirdPartyText", {
              owner: provenance.owner ?? t("fragments.provenance.importedFile"),
              date,
            })}
      </p>

      {link && (
        <button
          type="button"
          onClick={() => void appSettingsApi.openExternal(link)}
          className="inline-flex max-w-full items-center gap-1 self-start text-[11px] text-primary hover:underline"
        >
          <span className="truncate">{link}</span>
          <ExternalLink className="size-3 shrink-0" />
        </button>
      )}

      {modifiedAt && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {t("fragments.provenance.modified")}
        </p>
      )}

      {isUntrusted(provenance) && (
        <div className="flex flex-col gap-1.5">
          <p className="flex gap-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            {t("fragments.provenance.untrusted")}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-6 self-start px-2 text-[11px]"
            onClick={() => void fragmentApi.markReviewed(fragmentId)}
          >
            {t("fragments.provenance.markReviewed")}
          </Button>
        </div>
      )}
    </div>
  )
}

/** The body of the "notifications" row, kept together with the row for convenience. */
export function NotificationsDisclosure({
  fragmentId,
  defaultOpen = false,
}: {
  fragmentId: string
  defaultOpen?: boolean
}) {
  const { t } = useTranslation()
  const notifications = useFragmentNotifications(fragmentId)
  return (
    <DetailsDisclosure
      icon={Bell}
      label={t("fragments.details.notifications")}
      value={notifications.items.length}
      defaultOpen={defaultOpen}
    >
      <NotificationsList
        items={notifications.items}
        failed={notifications.failed}
        onCancel={notifications.cancel}
      />
    </DetailsDisclosure>
  )
}

/** The last row: everything that is only looked at. */
