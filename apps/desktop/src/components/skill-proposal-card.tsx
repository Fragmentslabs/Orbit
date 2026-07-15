import { useEffect } from "react"
import { Check, FileCode2, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ToolPart } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"
import { useSkillsStore } from "@/src/stores/skills-store"

/**
 * Card da proposta de skill (tool create_skill): a skill fica em staging até
 * o usuário clicar "Adicionar skill". Estado derivado do skills-store —
 * pendente → botões; aprovada → check; dispensada → nota.
 */

function slugOf(part: ToolPart): string | null {
  // O output da tool confirma o slug sanitizado ("Skill @<slug> proposta…")
  const fromOutput = part.output?.match(/@([a-z0-9_]+)/)?.[1]
  if (fromOutput) return fromOutput
  const raw = (part.input?.slug ?? part.input?.name) as string | undefined
  return raw ? raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_") : null
}

export function SkillProposalCard({ part }: { part: ToolPart }) {
  const initialize = useSkillsStore((s) => s.initialize)
  const pending = useSkillsStore((s) => s.pending)
  const skills = useSkillsStore((s) => s.skills)
  const approve = useSkillsStore((s) => s.approve)
  const discard = useSkillsStore((s) => s.discard)

  useEffect(() => {
    void initialize()
  }, [initialize])

  if (part.state === "running") {
    return <Shimmer className="text-sm">Montando a skill…</Shimmer>
  }
  if (part.state === "error") return null

  const slug = slugOf(part)
  if (!slug) return null

  const proposal = pending.find((p) => p.slug === slug)
  const installed = skills.some((s) => s.slug === slug)
  const name = (part.input?.name as string) ?? slug
  const description = (part.input?.description as string) ?? ""
  const files = proposal?.files ?? (part.input?.files as Array<{ path: string }> | undefined)?.map((f) => f.path) ?? []

  return (
    <div className="not-prose my-2 flex w-full flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
              @{slug}
            </Badge>
          </div>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          {files.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {files.map((file) => (
                <span
                  key={file}
                  className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  <FileCode2 className="size-3" />
                  {file}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {installed ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-500">
          <Check className="size-3.5" /> Skill adicionada — disponível como @{slug} na paleta "/"
        </p>
      ) : proposal ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => void discard(slug)}>
            Dispensar
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => void approve(slug)}>
            <Sparkles className="size-3.5" />
            Adicionar skill
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Proposta dispensada.</p>
      )}
    </div>
  )
}
