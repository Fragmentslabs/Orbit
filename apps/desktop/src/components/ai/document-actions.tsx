import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, Download, Library, Loader2 } from "lucide-react"
import { DOCUMENT_DOWNLOADS, type DocumentDownload } from "@shared/media"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { docsApi, documentApi } from "@/src/lib/ipc"

/**
 * Os dois controles que o documento carrega onde quer que ele apareça — o
 * card da conversa e o canvas do painel.
 *
 * Vivem aqui porque os dois lugares precisam do MESMO comportamento: baixar
 * renderiza na hora e pode falhar, promover a fonte depende de um estado que
 * muda por fora. Duplicar isso em dois componentes garantiria que um dos dois
 * ficasse para trás.
 */

const LABEL: Record<DocumentDownload, string> = { md: "Markdown", pdf: "PDF", docx: "Word" }
const EXT: Record<DocumentDownload, string> = { md: ".md", pdf: ".pdf", docx: ".docx" }

/** Estilo comum dos dois: pastilha discreta, do tamanho do cabeçalho do card. */
const PILL = "h-6 gap-1 px-2 text-[11px] font-normal"

export function DocumentDownloadMenu({
  documentId,
  onError,
  beforeDownload,
}: {
  documentId: string
  onError: (message: string) => void
  /** Roda antes de baixar — o canvas grava o que estava na pausa da digitação,
   *  senão o arquivo sairia com o texto de antes. */
  beforeDownload?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<DocumentDownload | null>(null)

  const download = useCallback(
    async (format: DocumentDownload) => {
      await beforeDownload?.()
      setBusy(format)
      try {
        const result = await documentApi.export(documentId, format)
        // Cancelar no diálogo de salvar não é erro: o usuário desistiu.
        if (!result.ok && !result.canceled) onError(result.error ?? t("sources.actionFailed"))
      } finally {
        setBusy(null)
      }
    },
    [documentId, beforeDownload, onError, t],
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className={PILL} disabled={busy !== null} />}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
        {t("documents.download")}
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {DOCUMENT_DOWNLOADS.map((format) => (
          <DropdownMenuItem key={format} onClick={() => void download(format)}>
            {LABEL[format]}
            <span className="ml-auto pl-3 text-[10px] text-muted-foreground">{EXT[format]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Promover o documento a fonte da conversa — e mostrar se ele JÁ é uma.
 *
 * O estado é lido do disco, não guardado aqui: a fonte pode ser removida na
 * aba Fontes a qualquer momento, e aí a pastilha volta a ser clicável. É o
 * `documents:changed` que avisa, o mesmo evento que atualiza a aba Fontes.
 */
export function DocumentSourceBadge({
  documentId,
  sessionId,
  onError,
  beforeAdd,
}: {
  documentId: string
  sessionId: string
  onError: (message: string) => void
  beforeAdd?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [isSource, setIsSource] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void documentApi.isSource(sessionId, documentId).then(setIsSource)
  }, [sessionId, documentId])

  useEffect(refresh, [refresh])
  // Remover a fonte na aba Fontes tem que soltar esta pastilha de volta.
  useEffect(() => docsApi.onChanged(refresh), [refresh])

  const add = useCallback(async () => {
    await beforeAdd?.()
    setBusy(true)
    try {
      const result = await documentApi.useAsSource(sessionId, documentId)
      if (result.ok) setIsSource(true)
      else onError(result.error)
    } finally {
      setBusy(false)
    }
  }, [sessionId, documentId, beforeAdd, onError])

  return (
    <Button
      variant={isSource ? "secondary" : "outline"}
      size="sm"
      className={PILL}
      disabled={busy || isSource}
      title={isSource ? t("documents.isSource") : t("documents.useAsSource")}
      onClick={() => void add()}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Library className="size-3" />}
      {isSource ? t("documents.sourceBadgeOn") : t("documents.sourceBadgeOff")}
    </Button>
  )
}
