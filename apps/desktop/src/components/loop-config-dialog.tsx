import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useLoopConfigStore } from "@/src/stores/loop-config-store"
import { RefreshCw } from "lucide-react"

export function LoopConfigDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const config = useLoopConfigStore((s) => s.config)
  const updateConfig = useLoopConfigStore((s) => s.updateConfig)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="size-4" />
            {t("loopConfig.title")}
          </DialogTitle>
          <DialogDescription>
            {t("loopConfig.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{t("loopConfig.maxIterations")}</span>
            <Input
              type="number"
              min={1}
              max={10}
              value={config.maxIterations}
              onChange={(e) => updateConfig({ maxIterations: Math.max(1, Math.min(10, Number(e.target.value))) })}
            />
            <span className="text-[10px] text-muted-foreground">
              {t("loopConfig.maxIterationsHint")}
            </span>
          </label>

        </div>
        <DialogFooter showCloseButton>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t("loopConfig.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
