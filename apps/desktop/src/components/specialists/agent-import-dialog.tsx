import { useCallback, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ShieldAlert } from "lucide-react"
import { AGENT_FILE_EXTENSION, AGENT_FILE_MAX_BYTES, type AgentImportErrorCode, type AgentImportPreview } from "@shared/agent-share"
import { AGENT_FEATURES } from "@shared/agents"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { agentsApi } from "@/src/lib/ipc"

export type AgentImportProblem = AgentImportErrorCode | "not_agent_file" | "limit" | "failed"

/**
 * Importing a shared agent from a file. Choosing the file only asks the main process to
 * read and validate it; nothing is saved until the person confirms the card, and the card
 * shows the whole definition — what the agent says, which skills it carries, which features
 * it switches on and which tools it is limited to.
 */
export function useAgentImport() {
  const [preview, setPreview] = useState<AgentImportPreview | null>(null)
  const [problem, setProblem] = useState<AgentImportProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)

  const start = useCallback(async (file: File) => {
    setProblem(null)
    if (!file.name.toLowerCase().endsWith(AGENT_FILE_EXTENSION)) return setProblem("not_agent_file")
    if (file.size > AGENT_FILE_MAX_BYTES) return setProblem("too_large")
    setBusy(true)
    try {
      const result = await agentsApi.importPreview(file.name, await file.text())
      if (result.ok) setPreview(result.preview)
      else setProblem(result.code)
    } catch {
      setProblem("failed")
    } finally {
      setBusy(false)
    }
  }, [])

  const pickFile = useCallback(() => {
    if (!input.current) {
      const el = document.createElement("input")
      el.type = "file"
      el.accept = AGENT_FILE_EXTENSION
      el.onchange = () => {
        const file = el.files?.[0]
        el.value = ""
        if (file) void start(file)
      }
      input.current = el
    }
    input.current.click()
  }, [start])

  const cancel = useCallback(() => {
    if (preview) void agentsApi.importCancel(preview.token)
    setPreview(null)
  }, [preview])

  const confirm = useCallback(async () => {
    if (!preview) return
    setBusy(true)
    try {
      const result = await agentsApi.importConfirm(preview.token)
      setPreview(null)
      if (!result.ok) setProblem(result.code === "limit" ? "limit" : "failed")
    } finally {
      setBusy(false)
    }
  }, [preview])

  return { preview, problem, busy, pickFile, cancel, confirm, dismissProblem: () => setProblem(null) }
}

export function AgentImportProblemNote({ problem, onDismiss }: { problem: AgentImportProblem | null; onDismiss: () => void }) {
  const { t } = useTranslation()
  if (!problem) return null
  return (
    <div role="alert" className="mb-2 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <span>{t(`specialists.share.errors.${problem}`)}</span>
      <button type="button" onClick={onDismiss} className="shrink-0 underline">
        {t("common.close")}
      </button>
    </div>
  )
}

export function AgentImportDialog({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: AgentImportPreview | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const agent = preview?.agent
  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        {preview && agent && (
          <>
            <DialogHeader>
              <DialogTitle>{t("specialists.share.importTitle", { name: agent.name })}</DialogTitle>
              <DialogDescription>{t("specialists.share.importDescription", { file: preview.fileName })}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3 text-xs">
              <section>
                <h3 className="mb-1 font-medium">{t("specialists.share.whenToUse")}</h3>
                <p className={agent.whenToUse ? "" : "text-muted-foreground"}>{agent.whenToUse || t("specialists.share.neverSuggested")}</p>
              </section>

              <section>
                <h3 className="mb-1 font-medium">{t("specialists.share.prompt")}</h3>
                {agent.prompt ? (
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 p-2 font-sans">{agent.prompt}</pre>
                ) : (
                  <p className="text-muted-foreground">{t("specialists.share.noPrompt")}</p>
                )}
              </section>

              <section>
                <h3 className="mb-1 font-medium">{t("specialists.share.features")}</h3>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                  {AGENT_FEATURES.map((feature) => (
                    <li key={feature} className="flex justify-between gap-2">
                      <span>{t(`specialists.block.${feature}.title`)}</span>
                      <span className={agent.features[feature] ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
                        {agent.features[feature] ? t("specialists.view.on") : t("specialists.view.off")}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="mb-1 font-medium">{t("specialists.share.tools")}</h3>
                {agent.allowedTools ? (
                  <p className="font-mono">{agent.allowedTools.length ? agent.allowedTools.join(", ") : t("specialists.share.noTools")}</p>
                ) : (
                  <p className="text-muted-foreground">{t("specialists.share.allTools")}</p>
                )}
                {agent.craft && <p className="mt-1">{t("specialists.share.craft", { craft: agent.craft })}</p>}
              </section>

              <section>
                <h3 className="mb-1 font-medium">{t("specialists.share.skills")}</h3>
                {agent.pinnedSkills.length ? (
                  <p className="font-mono">{agent.pinnedSkills.join(", ")}</p>
                ) : (
                  <p className="text-muted-foreground">{t("specialists.share.noSkills")}</p>
                )}
              </section>

              {preview.ignored.length > 0 && <p className="text-muted-foreground">{t("specialists.share.ignored")}</p>}

              <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-300">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                <p>{t("specialists.share.warning")}</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={onConfirm} disabled={busy}>
                {t("specialists.share.import")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
