import { useTranslation } from "react-i18next"
import { ShieldAlert } from "lucide-react"
import type { FragmentImportPreview } from "@shared/fragment-package"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatBytes } from "@/src/lib/format"
import type { FragmentImportProblem } from "./use-fragment-import"

/**
 * The consent card of an import. It shows what the file contains and says what an import
 * does and does not do: the code arrives but runs with nothing allowed, it is marked as
 * not reviewed, and nothing is pinned anywhere. Nothing is written until "Import".
 */
export function FragmentImportDialog({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: FragmentImportPreview | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        {preview && (
          <>
            <DialogHeader>
              <DialogTitle>{t("fragments.share.importTitle", { name: preview.name })}</DialogTitle>
              <DialogDescription>{t("fragments.share.importDescription")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3 text-xs">
              {preview.description && <p className="whitespace-pre-wrap">{preview.description}</p>}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">{t("fragments.share.file")}</dt>
                <dd className="truncate">{preview.fileName}</dd>
                <dt className="text-muted-foreground">{t("fragments.share.author")}</dt>
                <dd>{preview.author ? t("fragments.share.authorClaim", { author: preview.author }) : t("fragments.share.noAuthor")}</dd>
                <dt className="text-muted-foreground">{t("fragments.share.kind")}</dt>
                <dd>{t(`fragments.kind.${preview.kind}.name`)}</dd>
                <dt className="text-muted-foreground">{t("fragments.share.hash")}</dt>
                <dd className="truncate font-mono">{preview.sha256.slice(0, 16)}…</dd>
              </dl>

              <section>
                <h3 className="mb-1 font-medium">{t("fragments.share.asks")}</h3>
                {preview.requests.length === 0 ? (
                  <p className="text-muted-foreground">{t("fragments.share.asksNothing")}</p>
                ) : (
                  <ul className="list-disc pl-4">
                    {preview.requests.map((cap) => (
                      <li key={cap}>{t(`fragments.share.capabilities.${cap}`)}</li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-1 font-medium">
                  {t("fragments.share.files", { count: preview.files.length, size: formatBytes(preview.totalBytes) })}
                </h3>
                <ul className="max-h-32 overflow-y-auto rounded-md border border-border/60 p-2 font-mono">
                  {preview.files.map((f) => (
                    <li key={f.path} className="flex justify-between gap-3">
                      <span className="truncate">{f.path}</span>
                      <span className="shrink-0 text-muted-foreground">{formatBytes(f.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-300">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                <p>{t("fragments.share.warning")}</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onCancel} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button onClick={onConfirm} disabled={busy}>
                {t("fragments.share.import")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** A one-line, dismissible explanation of why an import was refused. */
export function FragmentImportProblemNote({ problem, onDismiss }: { problem: FragmentImportProblem | null; onDismiss: () => void }) {
  const { t } = useTranslation()
  if (!problem) return null
  return (
    <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <span>{t(`fragments.share.errors.${problem}`)}</span>
      <button type="button" onClick={onDismiss} className="shrink-0 underline">
        {t("common.close")}
      </button>
    </div>
  )
}
