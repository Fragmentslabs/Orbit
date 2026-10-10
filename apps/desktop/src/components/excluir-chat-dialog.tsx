import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { FolderGit2, LoaderIcon } from "lucide-react"
import type { SessionInfo } from "@shared/chat"
import type { ListaWorktrees, WorktreeInfo } from "@shared/worktrees"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { worktreeApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { useWorktreeStore } from "@/src/stores/worktree-store"

/** A pasta está dentro (ou é) a raiz dada — comparação por caminho, sem tocar no disco. */
function dentro(pasta: string, raiz: string): boolean {
  const normalizar = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
  const a = normalizar(pasta)
  const b = normalizar(raiz)
  return a === b || a.startsWith(`${b}/`)
}

/**
 * Excluir um chat. Se ele trabalhava num worktree criado por chat que nenhum
 * outro chat usa, pergunta se o worktree vai junto (como o Claude Code faz ao
 * sair de um worktree): o padrão é manter. Remover com alterações não
 * commitadas ou commits que o principal não tem exige confirmar o descarte.
 */
export function ExcluirChatDialog({
  session,
  open,
  onOpenChange,
}: {
  session: SessionInfo
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [worktree, setWorktree] = useState<{ lista: ListaWorktrees; info: WorktreeInfo } | null>(null)
  const [remover, setRemover] = useState(false)
  const [descartar, setDescartar] = useState(false)
  const [apagarBranch, setApagarBranch] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setWorktree(null)
    setRemover(false)
    setDescartar(false)
    setApagarBranch(false)
    setErro(null)
    const pasta = session.mode === "code" ? session.directory : undefined
    if (!pasta) return
    let vivo = true
    void worktreeApi
      .listar(pasta)
      .then((lista) => {
        if (!vivo || !lista) return
        const info = lista.worktrees.find((w) => w.caminho === lista.atual)
        // Só os criados por chat: o principal não sai, os da esteira são dela
        // e os externos foram criados à mão — não cabe ao chat removê-los.
        if (!info || info.origem !== "chat") return
        const outros = useSessionStore
          .getState()
          .sessions.some((s) => s.id !== session.id && !!s.directory && dentro(s.directory, info.caminho))
        if (!outros) setWorktree({ lista, info })
      })
      .catch(() => {})
    return () => {
      vivo = false
    }
  }, [open, session.id, session.mode, session.directory])

  // O que se perde de fato: remover o worktree leva as alterações não
  // commitadas; os commits só somem se o branch for apagado junto.
  const perdas = worktree && remover
    ? [
        worktree.info.alteracoes > 0 ? t("worktree.alteracoes", { count: worktree.info.alteracoes }) : null,
        apagarBranch && worktree.info.aFrente > 0 ? t("worktree.aFrente", { count: worktree.info.aFrente }) : null,
      ].filter((p): p is string => !!p)
    : []
  const bloqueado = perdas.length > 0 && !descartar

  const confirmar = async () => {
    setEnviando(true)
    setErro(null)
    try {
      // O worktree sai ANTES do chat: se a remoção falhar, o chat continua
      // existindo e dá para tentar de novo, em vez de deixar um órfão.
      if (remover && worktree) {
        await useWorktreeStore.getState().remover(worktree.lista.repo, worktree.info.caminho, apagarBranch)
      }
      await useSessionStore.getState().deleteSession(session.id)
      onOpenChange(false)
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    } finally {
      setEnviando(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !enviando && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("sidebar.session.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("sidebar.session.deleteDescription", { title: session.title })}</DialogDescription>
        </DialogHeader>

        {worktree && (
          <div className="space-y-2 rounded-md border p-2.5 text-xs">
            <p className="flex items-center gap-1.5 font-medium">
              <FolderGit2 className="size-3.5 shrink-0" />
              {t("excluirChat.worktree", { nome: worktree.info.nome, branch: worktree.info.branch ?? worktree.info.head })}
            </p>
            <label className="flex cursor-pointer items-center gap-2">
              <Switch checked={remover} onCheckedChange={setRemover} />
              <span>{t("excluirChat.removerWorktree")}</span>
            </label>
            {remover && (
              <>
                {worktree.info.branch && (
                  <label className="flex cursor-pointer items-center gap-2">
                    <Switch checked={apagarBranch} onCheckedChange={setApagarBranch} />
                    <span>{t("worktree.apagarBranch", { branch: worktree.info.branch })}</span>
                  </label>
                )}
                {perdas.length > 0 && (
                  <div className="space-y-1.5 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive">
                    <p>{t("excluirChat.perdas", { itens: perdas.join(" · ") })}</p>
                    <label className="flex cursor-pointer items-center gap-2">
                      <Switch checked={descartar} onCheckedChange={setDescartar} />
                      <span>{t("excluirChat.descartar")}</span>
                    </label>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {erro && <p className="break-words font-mono text-xs text-destructive">{erro}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void confirmar()} disabled={enviando || bloqueado}>
            {enviando && <LoaderIcon className="size-3.5 animate-spin" />}
            {t("sidebar.session.confirmDelete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
