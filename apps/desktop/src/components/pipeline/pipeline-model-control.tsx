import { useTranslation } from "react-i18next"
import type { ReasoningConfig } from "@shared/chat"
import type { Pipeline } from "@shared/pipeline"
import { pipelineModel } from "@shared/pipeline"
import { Hint } from "@/components/ui/hint"
import { ModelPicker } from "@/src/components/model-picker"
import { ThinkingMenu } from "@/src/components/thinking-menu"
import { usePipelineStore } from "@/src/stores/pipeline-store"

/**
 * The pipeline model on the board: the default of every phase and the one that
 * resolves merge conflicts and writes commit messages. Phases that were using
 * the old model follow the new one; phases with a model of their own keep it.
 */
export function PipelineModelControl({ pipeline }: { pipeline: Pipeline }) {
  const { t } = useTranslation()
  const updatePipeline = usePipelineStore((s) => s.updatePipeline)
  const current = pipelineModel(pipeline)

  const change = (next: { providerId: string; modelId: string } | null, reasoning?: ReasoningConfig | null) => {
    if (!next) return
    const previous = current
    void updatePipeline(pipeline.id, {
      model: { ...next, reasoning: reasoning !== undefined ? reasoning : (current?.reasoning ?? null) },
      phases: pipeline.phases.map((phase) =>
        previous && phase.providerId === previous.providerId && phase.modelId === previous.modelId
          ? { ...phase, providerId: next.providerId, modelId: next.modelId }
          : phase,
      ),
    })
  }

  return (
    <Hint label={t("pipeline.plan.modelTitle")}>
      <div className="flex items-center gap-1">
        <ModelPicker
          value={current ? { providerId: current.providerId, modelId: current.modelId } : null}
          onValueChange={(model) => change(model)}
          hideRotationOptions
          triggerClassName="h-8 max-w-48 rounded-md border border-input bg-transparent px-2 text-xs font-normal"
        />
        {current && (
          <ThinkingMenu
            model={{ providerId: current.providerId, modelId: current.modelId }}
            value={current.reasoning ?? null}
            onChange={(reasoning) => change({ providerId: current.providerId, modelId: current.modelId }, reasoning)}
          />
        )}
      </div>
    </Hint>
  )
}
