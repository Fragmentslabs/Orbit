"use client"

import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { MessageResponse } from "@/src/components/ai/message"
export function PlanDialog({
  content,
  open,
  onOpenChange,
}: {
  content: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()

  const checkboxCount = content
    ? [...content.matchAll(/\[(\s|x)\]/gi)].length
    : 0
  const checkedCount = content
    ? [...content.matchAll(/\[x\]/gi)].length
    : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            PLAN.md
            {checkboxCount > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                {t("planDialog.doneCount", { checked: checkedCount, total: checkboxCount })}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 px-1">
          {content ? (
            <MessageResponse>{content}</MessageResponse>
          ) : (
            <p className="text-sm text-muted-foreground">{t("planDialog.notFound")}</p>
          )}
        </div>

      </DialogContent>
    </Dialog>
  )
}
