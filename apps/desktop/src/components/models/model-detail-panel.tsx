import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Check } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { ModelScores, OrbitModel } from "@shared/models"
import { useModelsStore } from "@/src/stores/models-store"
import { availabilityLabel, formatContext, formatPrice, SCORE_CATEGORIES, SPEED_LABELS } from "./meta"
import { ScoreBar } from "./shared"

/** Painel direito com o perfil completo do modelo clicado na tabela. */

/** "Best For" derivado dos scores/capacidades — base dos futuros perfis de agentes. */
function bestForOf(model: OrbitModel): string[] {
  const items: string[] = []
  const s = model.scores
  if ((s.coding ?? 0) >= 80) items.push("architecture", "refactoring")
  else if ((s.coding ?? 0) >= 60) items.push("coding")
  if ((s.agentic ?? 0) >= 70) items.push("agents")
  if (model.contextWindow >= 400_000) items.push("largeProjects")
  if ((s.vision ?? 0) >= 60) items.push("visionTasks")
  if ((s.speed ?? 0) >= 70 && model.priceTier !== "premium") items.push("highVolume")
  if (model.speedTier === "deep") items.push("deepReasoning")
  if (model.priceTier === "free" || model.priceTier === "low") items.push("costSensitive")
  return items.slice(0, 6)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  )
}

export function ModelDetailPanel() {
  const { t } = useTranslation()
  const snapshot = useModelsStore((s) => s.snapshot)
  const detailId = useModelsStore((s) => s.detailId)
  const setDetailId = useModelsStore((s) => s.setDetailId)

  const model = useMemo(
    () => snapshot?.models.find((m) => m.id === detailId) ?? null,
    [snapshot, detailId],
  )

  const bestFor = useMemo(() => (model ? bestForOf(model) : []), [model])

  return (
    <Sheet open={model != null} onOpenChange={(open) => !open && setDetailId(null)}>
      {model && (
        <SheetContent side="right" className="gap-0 overflow-y-auto p-4 sm:max-w-md">
          <SheetHeader className="p-0 pb-4">
            <SheetTitle className="pr-8 text-base">{model.name}</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-1.5">
              {model.providerName}
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                {t(`models.speeds.${model.speedTier}`, { defaultValue: SPEED_LABELS[model.speedTier] })}
              </Badge>
              {model.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="h-4 px-1.5 text-[10px]">
                  {tag}
                </Badge>
              ))}
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-5">
            <Section title={t("models.detail.overview")}>
              <div className="space-y-2.5">
                {SCORE_CATEGORIES.map((cat) => (
                  <div key={cat.key}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span>{t(`models.categories.${cat.key}`)}</span>
                    </div>
                    <ScoreBar score={model.scores[cat.key as keyof ModelScores]} />
                  </div>
                ))}
              </div>
            </Section>

            {bestFor.length > 0 && (
              <Section title={t("models.detail.bestFor")}>
                <div className="grid grid-cols-2 gap-1.5">
                  {bestFor.map((item) => (
                    <div key={item} className="flex items-center gap-1.5 text-xs">
                      <Check className="size-3.5 text-emerald-500" />
                      {t(`models.detail.bestForItems.${item}`)}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title={t("models.detail.pricing")}>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border p-2.5">
                  <div className="text-[10px] text-muted-foreground">{t("models.detail.input")}</div>
                  <div className="text-sm font-medium tabular-nums">{formatPrice(model.pricing.input)}</div>
                </div>
                <div className="rounded-lg border p-2.5">
                  <div className="text-[10px] text-muted-foreground">{t("models.detail.output")}</div>
                  <div className="text-sm font-medium tabular-nums">{formatPrice(model.pricing.output)}</div>
                </div>
              </div>
            </Section>

            <Section title={t("models.detail.contextWindow")}>
              <div className="rounded-lg border p-2.5 text-sm font-medium tabular-nums">
                {formatContext(model.contextWindow)}
                {model.contextWindow > 0 && (
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">{t("models.detail.tokens")}</span>
                )}
              </div>
            </Section>

            {(model.benchmarks.tokensPerSecond !== undefined || model.benchmarks.ttft !== undefined) && (
              <Section title={t("models.detail.performance")}>
                <div className="grid grid-cols-2 gap-2">
                  {model.benchmarks.tokensPerSecond !== undefined && (
                    <div className="rounded-lg border p-2.5">
                      <div className="text-[10px] text-muted-foreground">{t("models.detail.tokensPerSecond")}</div>
                      <div className="text-sm font-medium tabular-nums">
                        {model.benchmarks.tokensPerSecond.toFixed(0)}
                      </div>
                    </div>
                  )}
                  {model.benchmarks.ttft !== undefined && (
                    <div className="rounded-lg border p-2.5">
                      <div className="text-[10px] text-muted-foreground">{t("models.detail.ttft")}</div>
                      <div className="text-sm font-medium tabular-nums">
                        {model.benchmarks.ttft.toFixed(2)}s
                      </div>
                    </div>
                  )}
                </div>
              </Section>
            )}

            <Section title={t("models.detail.providers")}>
              <div className="flex flex-wrap gap-1.5">
                {model.availability.map((provider) => (
                  <Badge key={provider} variant="secondary" className="text-[10px]">
                    {availabilityLabel(provider)}
                  </Badge>
                ))}
              </div>
            </Section>

            {model.releaseDate && (
              <div className="text-[10px] text-muted-foreground">
                {t("models.detail.released", { date: model.releaseDate, sources: model.sources.join(", ") })}
              </div>
            )}
          </div>
        </SheetContent>
      )}
    </Sheet>
  )
}
