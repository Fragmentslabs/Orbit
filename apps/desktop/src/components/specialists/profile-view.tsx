import { useTranslation } from "react-i18next"
import type { ProfileBlocks, ProfileDescription } from "@shared/agents"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

/** The order the switches are shown in, and the ones the person's own toggles still decide. */
export const BLOCK_ORDER: Array<keyof ProfileBlocks> = [
  "memories",
  "skills",
  "subagents",
  "orchestra",
  "loop",
  "vision",
  "web",
  "computer",
  "plan",
]

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div>
        <h4 className="text-xs font-semibold">{title}</h4>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

/**
 * Exactly what a profile puts in front of the model: the system prompt, the tools, which
 * blocks are on, and what is added at every turn. Read-only — it is the transparency view,
 * the same for a built-in craft and for an agent the person made.
 */
export function ProfileView({ description }: { description: ProfileDescription }) {
  const { t } = useTranslation()
  const { systemPrompt, tools, generalTools, blocks, turnContext } = description
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section title={t("specialists.view.prompt")} hint={description.builtin ? t("specialists.view.promptHintBuiltin") : undefined}>
        {systemPrompt.trim() ? (
          <ScrollArea className="max-h-64 rounded-md border bg-muted/30">
            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed">{systemPrompt}</pre>
          </ScrollArea>
        ) : (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t("specialists.view.noPrompt")}</p>
        )}
      </Section>

      <Section title={t("specialists.view.weight")} hint={t("specialists.view.weightHint")}>
        <p className="text-xs text-muted-foreground">
          {t("specialists.view.weightLine", {
            prompt: Math.ceil(description.weight.prompt / 4),
            pinned: Math.ceil(description.weight.pinnedSkills / 4),
          })}
        </p>
      </Section>

      <Section title={t("specialists.view.tools")}>
        {tools.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {tools.map((name) => (
              <span key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {name}
              </span>
            ))}
          </div>
        ) : null}
        {generalTools && (
          <p className="text-xs text-muted-foreground">
            {tools.length > 0 ? t("specialists.view.toolsNarrowed") : t("specialists.view.toolsUsual")}
          </p>
        )}
      </Section>

      <Section title={t("specialists.view.blocks")} hint={t("specialists.view.blocksHint")}>
        <ul className="grid gap-1 @sm:grid-cols-2">
          {BLOCK_ORDER.map((block) => (
            <li key={block} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs">
              <span>{t(`specialists.block.${block}.title`)}</span>
              <span
                className={cn(
                  "rounded px-1 py-0.5 text-[10px]",
                  blocks[block] ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground",
                )}
              >
                {blocks[block] ? t("specialists.view.on") : t("specialists.view.off")}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("specialists.view.turn")}>
        <p className="text-xs text-muted-foreground">{turnContext ?? t("specialists.view.noTurn")}</p>
      </Section>
    </div>
  )
}
