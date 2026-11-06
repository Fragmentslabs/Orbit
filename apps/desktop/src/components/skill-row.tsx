import { useTranslation } from "react-i18next"
import { FileText, LoaderCircle, Pencil, Sparkles, Trash2, Wand2 } from "lucide-react"
import { Hint } from "@/components/ui/hint"
import { CardMenu } from "@/src/components/card-menu"
import type { Skill, SkillMetaView } from "@shared/skills"

/** How many uses without a card before the row nudges the user to optimize. */
const NUDGE_AFTER = 4

interface SkillRowProps {
  skill: Skill
  meta?: SkillMetaView
  optimizing: boolean
  /** Language the card would be written in ("Portuguese"/"English") differs from the card's */
  languageDiffers: boolean
  onView: () => void
  onEdit: () => void
  onRemove: () => void
  onOptimize: () => void
  onTogglePin: () => void
  onToggleNever: () => void
}

function daysAgo(at: number | null): number | null {
  if (at == null) return null
  return Math.max(0, Math.floor((Date.now() - at) / 86_400_000))
}

/**
 * One skill in the panel: the card (summary + tags) or its absence — shown as a state, never
 * as an error —, the usage line, and the controls that decide where it sits in the index.
 */
export function SkillRow({
  skill,
  meta,
  optimizing,
  languageDiffers,
  onView,
  onEdit,
  onRemove,
  onOptimize,
  onTogglePin,
  onToggleNever,
}: SkillRowProps) {
  const { t } = useTranslation()
  const builtin = skill.source === "builtin"
  const state = meta?.state ?? "none"
  const card = meta?.card
  const pinned = Boolean(meta?.prefs.pin)
  const never = Boolean(meta?.prefs.never)
  const conversations = meta?.conversations ?? 0
  const last = daysAgo(meta?.lastUsedAt ?? null)
  const showNudge = state === "none" && !builtin && conversations >= NUDGE_AFTER

  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Sparkles className="size-4 text-muted-foreground/50" />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">@{skill.slug}</span>
          <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
            {builtin ? t("mcp.skills.builtin") : skill.source}
          </span>
          {skill.scripts && skill.scripts.length > 0 && (
            <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {t("mcp.skills.scripts", { count: skill.scripts.length })}
            </span>
          )}
          {!builtin && state === "stale" && (
            <Hint label={t("mcp.skills.staleHint")}>
              <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                {t("mcp.skills.stale")}
              </span>
            </Hint>
          )}
          {pinned && (
            <Hint label={t("mcp.skills.pinHint")}>
              <span className="rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">{t("mcp.skills.pin")}</span>
            </Hint>
          )}
          {never && (
            <Hint label={t("mcp.skills.neverHint")}>
              <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{t("mcp.skills.never")}</span>
            </Hint>
          )}
          {optimizing && <LoaderCircle className="size-3 animate-spin text-primary" aria-label={t("mcp.skills.optimize")} />}
          {!builtin && state === "none" && (
            <Hint label={t("mcp.skills.noCardHint")}>
              <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                {t("mcp.skills.noCard")}
              </span>
            </Hint>
          )}
        </div>
        {(card?.summary || skill.description) && (
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
            {state === "valid" && card ? card.summary : skill.description}
          </p>
        )}
        {state === "valid" && card && card.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1" aria-label={t("mcp.skills.tagsLabel")}>
            {card.tags.map((tag) => (
              <span key={tag} className="rounded-full border px-1.5 py-px text-[10px] text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
        )}
        {!builtin && (
          <p className="mt-1 text-[10px] text-muted-foreground/80">
            {conversations > 0
              ? `${t("mcp.skills.usedIn", { count: conversations })}${
                  last != null ? ` · ${t("mcp.skills.lastUsed", { count: last })}` : ""
                }${meta?.scopeGlobal ? ` · ${t("mcp.skills.usageGlobal")}` : ""}`
              : t("mcp.skills.neverUsed")}
            {showNudge && ` · ${t("mcp.skills.optimizeNudge", { count: conversations })}`}
          </p>
        )}
      </div>
      {/* One button for everything else. The state the user wants to see at a glance (pinned,
          hidden from suggestions, being optimized) is a badge on the card. Native skills are
          read-only: to customize, the user creates their own with the same slug (the global one
          overrides the native one), so their menu only opens the content. */}
      <CardMenu
        items={[
          { id: "view", label: t("mcp.skills.viewContent"), icon: FileText, onSelect: onView },
          ...(builtin
            ? []
            : [
                { id: "pin", label: t("mcp.skills.pin"), checked: pinned, onSelect: onTogglePin },
                { id: "never", label: t("mcp.skills.never"), checked: never, onSelect: onToggleNever },
                {
                  id: "optimize",
                  label: languageDiffers && state === "valid" ? t("mcp.skills.optimizeInLanguage") : state === "valid" ? t("mcp.skills.reoptimize") : t("mcp.skills.optimize"),
                  icon: Wand2,
                  disabled: optimizing,
                  onSelect: onOptimize,
                },
                { id: "edit", label: t("mcp.skills.edit"), icon: Pencil, onSelect: onEdit },
                { id: "remove", label: t("mcp.skills.remove"), icon: Trash2, destructive: true, onSelect: onRemove },
              ]),
        ]}
      />
    </div>
  )
}
