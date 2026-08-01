import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ExternalLink, Gauge } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { authApi } from "@/src/lib/ipc"
import { useModelsStore } from "@/src/stores/models-store"

/**
 * Conexão com a Artificial Analysis: sem a chave (gratuita) não há dados de
 * velocidade (tokens/s, TTFT) nem benchmarks crus — só os índices que o
 * OpenRouter embute. A chave vai para o auth.json ("artificialanalysis").
 */

const AA_KEYS_URL = "https://artificialanalysis.ai/api-access"

export function AAKeyButton() {
  const { t } = useTranslation()
  const hasKey = useModelsStore((s) => s.snapshot?.hasAAKey ?? false)
  const refresh = useModelsStore((s) => s.refresh)
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState("")
  const [saving, setSaving] = useState(false)

  if (hasKey) return null

  const save = async () => {
    const trimmed = key.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      await authApi.set("artificialanalysis", trimmed)
      setOpen(false)
      setKey("")
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-6 gap-1.5 px-2 text-[11px] text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Gauge className="size-3" />
        {t("models.aa.connect")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("models.aa.title")}</DialogTitle>
            <DialogDescription>{t("models.aa.description")}</DialogDescription>
          </DialogHeader>
          <a
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            href={AA_KEYS_URL}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="size-3" />
            {t("models.aa.createKey")}
          </a>
          <Input
            autoFocus
            type="password"
            value={key}
            placeholder={t("models.aa.keyPlaceholder")}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save()
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button disabled={!key.trim() || saving} onClick={() => void save()}>
              {saving ? t("models.aa.saving") : t("models.aa.saveAndRefresh")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
