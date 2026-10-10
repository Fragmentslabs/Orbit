import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, FolderGit2, LoaderIcon, PlusIcon, XIcon } from "lucide-react"
import { BASE_REMOTO, type WorktreeInfo } from "@shared/worktrees"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useBranchStore } from "@/src/stores/branch-store"
import { useWorktreeStore } from "@/src/stores/worktree-store"
import { cn } from "@/lib/utils"

/** Nome mostrado: o principal aparece como "Principal", não pelo nome da pasta. */
export function useRotuloWorktreeAtual(pasta: string | undefined): string | null {
  const { t } = useTranslation()
  const lista = useWorktreeStore((s) => (pasta ? s.porPasta[pasta] : undefined))
  if (!lista) return null
  const atual = lista.worktrees.find((w) => w.caminho === lista.atual)
  if (!atual) return null
  return atual.principal ? t("worktree.principal") : atual.nome
}

/**
 * Seletor de worktree do chat (header): em que cópia de trabalho do
 * repositório este chat trabalha. Lista os worktrees — inclusive os criados
 * fora do Orbit e os das tasks da esteira —, troca a pasta do chat, cria e
 * remove. Escondido quando a pasta não é um repositório git.
 *
 * Trocar só muda a pasta principal deste chat (as extras ficam): a próxima
 * mensagem já roda lá.
 */
export function WorktreeSelector({
  pasta,
  onTrocar,
  sugestaoNome,
  open: openProp,
  onOpenChange,
  hideTrigger,
}: {
  /** Pasta principal do chat */
  pasta: string
  /** Troca a pasta principal do chat para esta */
  onTrocar: (pasta: string) => void
  /** Sugestão de nome para um worktree novo (ex.: título do chat) */
  sugestaoNome?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Sem botão próprio — aberto pelo seletor compacto */
  hideTrigger?: boolean
}) {
  const { t } = useTranslation()
  const lista = useWorktreeStore((s) => s.porPasta[pasta])
  const carregando = useWorktreeStore((s) => s.carregando[pasta] ?? false)
  const carregar = useWorktreeStore((s) => s.carregar)
  const [abertoInterno, setAbertoInterno] = useState(false)
  const aberto = openProp ?? abertoInterno
  const setAberto = onOpenChange ?? setAbertoInterno
  const [criando, setCriando] = useState(false)
  const [removendo, setRemovendo] = useState<WorktreeInfo | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void carregar(pasta)
  }, [pasta, carregar])

  // Estado (alterações, commits à frente) muda enquanto se trabalha: recarrega
  // ao abrir, para a lista não mostrar o retrato de quando o chat abriu.
  useEffect(() => {
    if (aberto) void carregar(pasta)
  }, [aberto, pasta, carregar])

  // hideTrigger: dropdown manual ancorado no wrapper, com fechamento por
  // clique fora — o mesmo arranjo do BranchSelector no seletor compacto.
  useEffect(() => {
    if (!hideTrigger || !aberto) return
    const fechar = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener("mousedown", fechar)
    return () => document.removeEventListener("mousedown", fechar)
  }, [hideTrigger, aberto, setAberto])

  if (!lista) return null
  const atual = lista.worktrees.find((w) => w.caminho === lista.atual)
  const rotuloAtual = !atual || atual.principal ? t("worktree.principal") : atual.nome

  const itens = (
    <>
      <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("worktree.titulo")}
      </p>
      {lista.worktrees.map((w) => (
        <LinhaWorktree
          key={w.caminho}
          worktree={w}
          atual={w.caminho === lista.atual}
          onEscolher={() => {
            setAberto(false)
            if (w.caminho !== lista.atual) onTrocar(w.pasta)
          }}
          onRemover={() => {
            setAberto(false)
            setRemovendo(w)
          }}
        />
      ))}
      <div className="mt-1 border-t border-foreground/10 pt-1">
        <button
          type="button"
          onClick={() => {
            setAberto(false)
            setCriando(true)
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <PlusIcon className="size-3.5 shrink-0" />
          {t("worktree.novo")}
        </button>
      </div>
    </>
  )

  return (
    <>
      {hideTrigger ? (
        <div className="relative" ref={ref}>
          {aberto && (
            <div className="absolute left-0 top-full z-[60] mt-1 w-72 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
              {itens}
            </div>
          )}
        </div>
      ) : (
        <DropdownMenu open={aberto} onOpenChange={setAberto}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                title={t("worktree.tituloAtual", { nome: rotuloAtual })}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-md border px-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
                  atual && !atual.principal ? "border-primary/40 bg-primary/5" : "border-border",
                )}
              />
            }
          >
            {carregando && !lista ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <FolderGit2 className={cn("size-3", atual && !atual.principal ? "text-primary" : "text-muted-foreground")} />
            )}
            <span className="max-w-24 truncate">{rotuloAtual}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72 p-1">
            {itens}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <CriarWorktreeDialog
        aberto={criando}
        onOpenChange={setCriando}
        pasta={pasta}
        repo={lista.repo}
        remotoPadrao={lista.remotoPadrao}
        sugestaoNome={sugestaoNome}
        onCriado={(novaPasta) => onTrocar(novaPasta)}
      />
      <RemoverWorktreeDialog worktree={removendo} pasta={pasta} onOpenChange={(v) => !v && setRemovendo(null)} />
    </>
  )
}

function LinhaWorktree({
  worktree: w,
  atual,
  onEscolher,
  onRemover,
}: {
  worktree: WorktreeInfo
  atual: boolean
  onEscolher: () => void
  onRemover: () => void
}) {
  const { t } = useTranslation()
  // O principal não sai (não é um worktree removível) e os da esteira são
  // dela; o atual também não — o chat precisa ir para outro antes.
  const removivel = !w.principal && w.origem !== "esteira" && !atual
  const detalhes = [
    w.branch ?? t("worktree.detached", { head: w.head }),
    w.alteracoes > 0 ? t("worktree.alteracoes", { count: w.alteracoes }) : null,
    w.aFrente > 0 ? t("worktree.aFrente", { count: w.aFrente }) : null,
    w.origem === "esteira" ? t("worktree.daEsteira") : w.origem === "externo" ? t("worktree.externo") : null,
    w.disponivel ? null : t("worktree.ausente"),
  ].filter(Boolean)

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md transition-colors",
        atual ? "bg-primary/10 text-primary" : "hover:bg-foreground/10",
      )}
    >
      <button
        type="button"
        disabled={!w.disponivel}
        onClick={onEscolher}
        title={w.caminho}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
      >
        <FolderGit2 className="size-3 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">{w.principal ? t("worktree.principal") : w.nome}</span>
          <span className={cn("block truncate text-[10px]", atual ? "text-primary/70" : "text-muted-foreground")}>
            {detalhes.join(" · ")}
          </span>
        </span>
        {atual && <Check className="size-3 shrink-0" />}
      </button>
      {removivel && (
        <button
          type="button"
          onClick={onRemover}
          aria-label={t("worktree.remover")}
          title={t("worktree.remover")}
          className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  )
}

function CriarWorktreeDialog({
  aberto,
  onOpenChange,
  pasta,
  repo,
  remotoPadrao,
  sugestaoNome,
  onCriado,
}: {
  aberto: boolean
  onOpenChange: (aberto: boolean) => void
  pasta: string
  repo: string
  /** Branch padrão do origin (ex.: origin/main) — a base "remoto atualizado" */
  remotoPadrao?: string
  sugestaoNome?: string
  onCriado: (pasta: string) => void
}) {
  const { t } = useTranslation()
  const criar = useWorktreeStore((s) => s.criar)
  const branches = useBranchStore((s) => s.byDir[repo])
  const fetchBranches = useBranchStore((s) => s.fetchBranches)
  const [nome, setNome] = useState("")
  const [base, setBase] = useState("")
  const [trocar, setTrocar] = useState(true)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    if (!aberto) return
    setNome(sugestaoNome && !/^nova sess/i.test(sugestaoNome) ? sugestaoNome : "")
    setBase("")
    setTrocar(true)
    setErro(null)
    void fetchBranches(repo)
  }, [aberto, sugestaoNome, repo, fetchBranches])

  const confirmar = async () => {
    if (!nome.trim() || enviando) return
    setEnviando(true)
    setErro(null)
    try {
      const criado = await criar(pasta, nome.trim(), base || undefined)
      onOpenChange(false)
      if (trocar) onCriado(criado.pasta)
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    } finally {
      setEnviando(false)
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !enviando && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("worktree.criarTitulo")}</DialogTitle>
          <DialogDescription>{t("worktree.criarDescricao")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("worktree.nome")}</p>
            <Input
              value={nome}
              autoFocus
              onChange={(e) => {
                setNome(e.target.value)
                setErro(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmar()
              }}
              placeholder={t("worktree.nomePlaceholder")}
            />
            <p className="text-[11px] text-muted-foreground">{t("worktree.nomeDica")}</p>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">{t("worktree.base")}</p>
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
            >
              <option value="" className="bg-popover text-popover-foreground">
                {t("worktree.baseAtual", { branch: branches?.current ?? "HEAD" })}
              </option>
              {/* O "fresh" do Claude Code: parte do remoto depois de um fetch,
                  sem levar commits locais que ainda não subiram. */}
              {remotoPadrao && (
                <option value={BASE_REMOTO} className="bg-popover text-popover-foreground">
                  {t("worktree.baseRemoto", { remoto: remotoPadrao })}
                </option>
              )}
              {(branches?.branches ?? [])
                .filter((b) => b !== branches?.current)
                .map((b) => (
                  <option key={b} value={b} className="bg-popover text-popover-foreground">
                    {b}
                  </option>
                ))}
            </select>
          </div>

          <label className="flex cursor-pointer items-center gap-2">
            <Switch checked={trocar} onCheckedChange={setTrocar} />
            <span className="text-xs">{t("worktree.trocarParaEle")}</span>
          </label>

          {enviando && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <LoaderIcon className="size-3 animate-spin" />
              {t("worktree.preparando")}
            </p>
          )}
          {erro && <p className="break-words font-mono text-xs text-destructive">{erro}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void confirmar()} disabled={!nome.trim() || enviando}>
            {t("worktree.criar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RemoverWorktreeDialog({
  worktree,
  pasta,
  onOpenChange,
}: {
  worktree: WorktreeInfo | null
  pasta: string
  onOpenChange: (aberto: boolean) => void
}) {
  const { t } = useTranslation()
  const remover = useWorktreeStore((s) => s.remover)
  const [apagarBranch, setApagarBranch] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    setApagarBranch(false)
    setErro(null)
  }, [worktree?.caminho])

  if (!worktree) return null

  const confirmar = async () => {
    setEnviando(true)
    setErro(null)
    try {
      await remover(pasta, worktree.caminho, apagarBranch)
      onOpenChange(false)
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    } finally {
      setEnviando(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !enviando && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("worktree.removerTitulo", { nome: worktree.nome })}</DialogTitle>
          <DialogDescription>{t("worktree.removerDescricao")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-xs">
          {worktree.alteracoes > 0 && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-destructive">
              {t("worktree.removerAlteracoes", { count: worktree.alteracoes })}
            </p>
          )}
          {worktree.origem === "externo" && (
            <p className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-2 text-yellow-700 dark:text-yellow-300">
              {t("worktree.removerExterno", { caminho: worktree.caminho })}
            </p>
          )}
          {worktree.branch && (
            <label className="flex cursor-pointer items-center gap-2">
              <Switch checked={apagarBranch} onCheckedChange={setApagarBranch} />
              <span>
                {t("worktree.apagarBranch", { branch: worktree.branch })}
                {worktree.aFrente > 0 && apagarBranch && (
                  <span className="block text-[11px] text-destructive">
                    {t("worktree.apagarBranchAviso", { count: worktree.aFrente })}
                  </span>
                )}
              </span>
            </label>
          )}
          {erro && <p className="break-words font-mono text-destructive">{erro}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void confirmar()} disabled={enviando}>
            {enviando ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            {t("worktree.remover")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
