import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertCircleIcon, CloudUploadIcon, GlobeIcon, LockIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** Espelha CreateRepoResult do main (electron/lib/github-repo.ts). */
type CreateRepoResult =
  | { ok: true; url: string; fullName: string; pushed: boolean }
  | { ok: false; kind: string; message: string }

/** Mesma regra do main — validar aqui evita uma ida à API para nada. */
function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== "." && name !== ".."
}

/**
 * Aberto quando o "enviar" falha por não haver remote: explica a situação e
 * oferece criar o repositório no GitHub ali mesmo.
 *
 * O token não é pedido — vem do credential helper do git. Se não houver
 * credencial (ou ela não tiver escopo para criar repositórios), o erro diz o
 * que fazer em vez de abrir um campo de token.
 */
export function CreateRemoteRepoDialog({ repoPath, open, onOpenChange, onCreated }: {
  repoPath: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Chamado após criar — o pai recarrega a lista de commits e o estado do git. */
  onCreated: (result: Extract<CreateRepoResult, { ok: true }>) => void
}) {
  const { t } = useTranslation()
  const [nome, setNome] = useState("")
  const [privado, setPrivado] = useState(true)
  const [criando, setCriando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  /** Aparece só depois de a leitura automática da credencial falhar. */
  const [pedirToken, setPedirToken] = useState(false)
  const [token, setToken] = useState("")

  useEffect(() => {
    if (!open) return
    // Sugere o nome da pasta, que é o que o usuário quase sempre quer.
    const base = repoPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
    setNome(base.replace(/[^A-Za-z0-9._-]/g, "-"))
    setPrivado(true)
    setErro(null)
    setCriando(false)
    setPedirToken(false)
    setToken("")
  }, [open, repoPath])

  const nomeValido = isValidRepoName(nome.trim())

  const criar = async () => {
    if (!nomeValido || criando) return
    setCriando(true)
    setErro(null)
    const result = (await window.ipcRenderer.invoke(
      "git:createRemoteRepo",
      repoPath,
      nome.trim(),
      privado,
      token.trim() || undefined,
    )) as CreateRepoResult
    setCriando(false)
    if (result.ok) {
      onCreated(result)
      onOpenChange(false)
      return
    }
    // Falha de credencial não é beco sem saída: abre o campo de token para o
    // usuário seguir agora, e mostra o motivo técnico para ele saber o que
    // aconteceu com o helper do git.
    if (result.kind === "noCredential" || result.kind === "auth") {
      setPedirToken(true)
      setErro(`${t(`createRepo.erro.${result.kind}`)}\n${result.message}`)
      return
    }
    const conhecido = ["nameTaken", "invalidName", "noCommits"]
    setErro(
      conhecido.includes(result.kind)
        ? t(`createRepo.erro.${result.kind}`)
        : `${t("createRepo.erro.other")}\n${result.message}`,
    )
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !criando && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <CloudUploadIcon className="size-4" />
            {t("createRepo.titulo")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{t("createRepo.descricao")}</p>

          <div>
            <p className="mb-1 text-xs font-medium">{t("createRepo.nomeLabel")}</p>
            <Input
              autoFocus
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void criar()
              }}
              placeholder={t("createRepo.nomePlaceholder")}
              disabled={criando}
            />
            {nome.trim() !== "" && !nomeValido && (
              <p className="mt-1 text-[11px] text-destructive">{t("createRepo.nomeInvalido")}</p>
            )}
          </div>

          {/* Privado por padrão: criar um repositório público sem querer expõe
              o código, e o caminho de volta é manual. */}
          <div className="flex gap-1.5">
            {([true, false] as const).map((valor) => (
              <button
                key={String(valor)}
                type="button"
                disabled={criando}
                onClick={() => setPrivado(valor)}
                className={cn(
                  "flex flex-1 items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors",
                  privado === valor ? "border-primary bg-primary/10" : "hover:bg-accent",
                )}
              >
                {valor ? <LockIcon className="size-3" /> : <GlobeIcon className="size-3" />}
                {t(valor ? "createRepo.privado" : "createRepo.publico")}
              </button>
            ))}
          </div>

          {pedirToken && (
            <div>
              <p className="mb-1 text-xs font-medium">{t("createRepo.tokenLabel")}</p>
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void criar()
                }}
                placeholder="ghp_…"
                disabled={criando}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">{t("createRepo.tokenHint")}</p>
            </div>
          )}

          {erro && (
            <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] whitespace-pre-line text-destructive">
              <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{erro}</span>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={criando} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!nomeValido || criando || (pedirToken && token.trim() === "")}
            onClick={() => void criar()}
          >
            {criando ? t("createRepo.criando") : t("createRepo.criar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
