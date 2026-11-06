import { useTranslation } from "react-i18next"
import { EyeOff, FileText, LoaderCircle, Pencil, Pin, Sparkles, Trash2, Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import { cn } from "@/lib/utils"
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
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-auto p-0 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={onView}
        >
          <FileText className="mr-1 size-3" />
          {t("mcp.skills.viewContent")}
        </Button>
      </div>
      {/* Native skills are read-only: to customize, the user creates their own with the
          same slug (the global one overrides the native one). */}
      {!builtin && (
        <div className="flex items-center gap-1 self-start pt-1">
          <Hint label={t("mcp.skills.pinHint")}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-pressed={pinned}
              aria-label={t("mcp.skills.pin")}
              className={cn(pinned && "text-foreground")}
              onClick={onTogglePin}
            >
              <Pin className={cn("size-3.5", pinned ? "fill-current" : "text-muted-foreground")} />
            </Button>
          </Hint>
          <Hint label={t("mcp.skills.neverHint")}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-pressed={never}
              aria-label={t("mcp.skills.never")}
              className={cn(never && "text-foreground")}
              onClick={onToggleNever}
            >
              <EyeOff className={cn("size-3.5", !never && "text-muted-foreground")} />
            </Button>
          </Hint>
          <Hint label={languageDiffers && state === "valid" ? t("mcp.skills.optimizeInLanguage") : state === "valid" ? t("mcp.skills.reoptimize") : t("mcp.skills.optimize")}>
            <Button size="icon-sm" variant="ghost" disabled={optimizing} onClick={onOptimize}>
              {optimizing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
            </Button>
          </Hint>
          <Hint label={t("mcp.skills.edit")}>
            <Button size="icon-sm" variant="ghost" onClick={onEdit}>
              <Pencil className="size-3.5" />
            </Button>
          </Hint>
          <Hint label={t("mcp.skills.remove")}>
            <Button size="icon-sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onRemove}>
              <Trash2 className="size-3.5" />
            </Button>
          </Hint>
        </div>
      )}
    </div>
  )
}
