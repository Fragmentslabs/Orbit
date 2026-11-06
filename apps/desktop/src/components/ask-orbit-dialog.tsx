import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertCircleIcon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useWorkspace } from "@/lib/workspace-context"
import { FolderSelector } from "@/src/components/folder-selector"
import { ModelPicker } from "@/src/components/model-picker"
import { LOCALE_PROMPT_NAME, useLocaleStore } from "@/src/stores/locale-store"
import type { SelectedModel } from "@/src/stores/provider-store"
import { sessionModelFor, useSessionModelPrefs } from "@/src/stores/session-model-prefs"

export type AskOrbitKind = "mcp" | "skills" | "hooks"

/**
 * "Ask Orbit to create it" modal of the Tools sections — the same step 1 of the new
 * routine dialog (free text, folders, model, Generate), with its own title, description
 * and example per section (`askOrbit.<kind>.*`).
 *
 * The model only SUGGESTS: on success the modal closes and hands the suggestion to the
 * caller, which opens the section's own form already filled in. Nothing is saved from
 * here, so the user always reviews what was written (a hook command, an MCP server
 * and a skill all run on their behalf).
 */
export function AskOrbitDialog<T>({ kind, open, onOpenChange, generate, onGenerated }: {
  kind: AskOrbitKind
  open: boolean
  onOpenChange: (open: boolean) => void
  generate: (
    description: string,
    model: { providerId: string; modelId: string },
    folders: string[],
    language?: string,
  ) => Promise<{ ok: true; suggestion: T } | { ok: false; error: string }>
  onGenerated: (suggestion: T) => void
}) {
  const { t } = useTranslation()
  const { folders: workspaceFolders } = useWorkspace()
  const [description, setDescription] = useState("")
  const [model, setModel] = useState<SelectedModel | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Every opening starts over, with the model of the last chat and the open workspace.
  useEffect(() => {
    if (!open) return
    setDescription("")
    setError(null)
    setGenerating(false)
    setModel(sessionModelFor(null))
    setFolders(workspaceFolders)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const canGenerate = description.trim().length > 0 && !!model && !generating

  const run = async () => {
    if (!canGenerate || !model) return
    setGenerating(true)
    setError(null)
    try {
      const language = LOCALE_PROMPT_NAME[useLocaleStore.getState().activeLocale]
      const result = await generate(description.trim(), model, folders, language)
      if (!result.ok) {
        setError(result.error)
        return
      }
      useSessionModelPrefs.getState().markUsed(model.providerId, model.modelId)
      onOpenChange(false)
      onGenerated(result.suggestion)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!generating) onOpenChange(next) }}>
      <DialogContent className="max-w-2xl overflow-hidden">
        <div className="min-w-0">
          <DialogTitle>{t(`askOrbit.${kind}.title`)}</DialogTitle>
          <p className="text-[11px] text-muted-foreground">{t(`askOrbit.${kind}.description`)}</p>
        </div>

        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run()
          }}
          placeholder={t(`askOrbit.${kind}.placeholder`)}
          className="max-h-64 min-h-36"
          disabled={generating}
          autoFocus
        />

        {error && (
          <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
            <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </p>
        )}

        {generating && (
          <div className="space-y-2 rounded-lg border bg-card p-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <FolderSelector folders={folders} onFoldersChange={setFolders} />
          <ModelPicker value={model} onValueChange={setModel} />
        </div>
        {!model && <p className="-mt-2 text-[11px] text-muted-foreground">{t("askOrbit.noModel")}</p>}

        <div className="flex justify-end">
          <Button size="sm" disabled={!canGenerate} onClick={() => void run()}>
            <SparklesIcon className="size-3.5" />
            {generating ? t("askOrbit.generating") : t("askOrbit.generate")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
