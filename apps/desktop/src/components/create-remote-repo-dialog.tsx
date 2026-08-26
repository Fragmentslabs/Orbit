import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertCircleIcon, CheckIcon, CloudUploadIcon, CopyIcon, GlobeIcon, LockIcon, TerminalIcon } from "lucide-react"

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

/** Espelha os detalhes crus do main (electron/lib/github-repo.ts). */
type GitCredDetalhe = {
  modo: "exit" | "spawn" | "timeout"
  codigo: number | null
  saida: string
}

type GhCredDetalhe = {
  estado: "missing" | "other"
  saida: string
}

/** Espelha CreateRepoResult do main (electron/lib/github-repo.ts). */
type CreateRepoResult =
  | { ok: true; url: string; fullName: string; pushed: boolean }
  | {
      ok: false
      kind: "noCredential"
      hint: "ghMissing" | "ghOther"
      detalhe: { git: GitCredDetalhe; gh: GhCredDetalhe }
    }
  | { ok: false; kind: "auth" | "nameTaken" | "invalidName" | "noCommits" | "other"; message: string }

/** Mesma regra do main — validar aqui evita uma ida à API para nada. */
function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== "." && name !== ".."
}

/**
 * Comando de instalação do GitHub CLI por sistema — mesmo comando do guia
 * oficial (cli.github.com). Plataformas fora do mapa caem na linha de link,
 * que aponta o guia; `gh auth login` é comum a todas.
 */
const INSTALL_CMD: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "brew install gh",
  win32: "winget install --id GitHub.cli",
  linux: "sudo apt install gh",
}

/**
 * Aberto quando o "enviar" falha por não haver remote: explica a situação e
 * oferece criar o repositório no GitHub ali mesmo.
 *
 * O token não é pedido nem colado — vem do credential helper do git ou do
 * GitHub CLI. Se não houver credencial, o erro instrui a instalar/autenticar
 * o `gh` (a mensagem varia conforme ele existe na máquina, pelo hint do main),
 * com o comando certo para o sistema e um botão de copiar; o detalhe técnico
 * do helper do git fica na última linha.
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
  /** Sem credencial: guarda o hint do main e os detalhes crus (traduzidos na renderização). */
  const [noCred, setNoCred] = useState<{
    hint: "ghMissing" | "ghOther"
    detalhe: { git: GitCredDetalhe; gh: GhCredDetalhe }
  } | null>(null)
  const [copiado, setCopiado] = useState(false)

  useEffect(() => {
    if (!open) return
    // Sugere o nome da pasta, que é o que o usuário quase sempre quer.
    const base = repoPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
    setNome(base.replace(/[^A-Za-z0-9._-]/g, "-"))
    setPrivado(true)
    setErro(null)
    setNoCred(null)
    setCopiado(false)
    setCriando(false)
  }, [open, repoPath])

  const nomeValido = isValidRepoName(nome.trim())

  const criar = async () => {
    if (!nomeValido || criando) return
    setCriando(true)
    setErro(null)
    setNoCred(null)
    const result = (await window.ipcRenderer.invoke(
      "git:createRemoteRepo",
      repoPath,
      nome.trim(),
      privado,
    )) as CreateRepoResult
    setCriando(false)
    if (result.ok) {
      onCreated(result)
      onOpenChange(false)
      return
    }
    // Sem credencial não há token a digitar: a instrução é instalar/autenticar
    // o GitHub CLI (a mensagem varia se o gh existe na máquina, pelo hint do
    // main), com o comando certo para o sistema e o detalhe técnico à parte.
    if (result.kind === "noCredential") {
      setNoCred({ hint: result.hint, detalhe: result.detalhe })
      return
    }
    if (result.kind === "auth") {
      setErro(`${t("createRepo.erro.auth")}\n${result.message}`)
      return
    }
    const conhecido = ["nameTaken", "invalidName", "noCommits"]
    setErro(
      conhecido.includes(result.kind)
        ? t(`createRepo.erro.${result.kind}`)
        : `${t("createRepo.erro.other")}\n${result.message}`,
    )
  }

  /** Comandos que desbloqueiam a criação, num passo único. */
  const linhasComando: string[] = []
  if (noCred?.hint === "ghMissing") {
    const instalar = INSTALL_CMD[window.platform]
    linhasComando.push(...(instalar ? [instalar, "gh auth login"] : ["gh auth login"]))
  } else if (noCred) {
    linhasComando.push("gh auth login")
  }

  /**
   * Monta o detalhe técnico no idioma da UI. As saídas cruas das ferramentas
   * (stderr do git, stderr do gh) são mostradas sem tradução — só a moldura
   * ("git saiu com N", "gh não encontrado…") é localizada.
   */
  const montarDetalhe = () => {
    if (!noCred) return ""
    const gitChave = ({
      exit: "createRepo.erro.detalheGitExit",
      spawn: "createRepo.erro.detalheGitSpawn",
      timeout: "createRepo.erro.detalheGitTimeout",
    } as const)[noCred.detalhe.git.modo]
    const partes: string[] = []
    const gitBase = t(gitChave, { codigo: noCred.detalhe.git.codigo ?? 0 })
    partes.push(noCred.detalhe.git.saida ? `${gitBase}: ${noCred.detalhe.git.saida}` : gitBase)
    if (noCred.detalhe.gh.estado === "missing") {
      partes.push(t("createRepo.erro.detalheGhAusente"))
    } else {
      partes.push(
        noCred.detalhe.gh.saida
          ? `${t("createRepo.erro.detalheGhFalhou")}: ${noCred.detalhe.gh.saida}`
          : t("createRepo.erro.detalheGhSemToken"),
      )
    }
    return partes.join("; ")
  }

  const copiarComandos = async () => {
    await navigator.clipboard.writeText(linhasComando.join(" && "))
    setCopiado(true)
    setTimeout(() => setCopiado(false), 2000)
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

          {erro && (
            <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] whitespace-pre-line text-destructive">
              <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{erro}</span>
            </p>
          )}

          {noCred && (
            <div className="overflow-hidden rounded-md border border-border">
              <div className="flex items-start gap-1.5 bg-destructive/10 p-2 text-[11px] whitespace-pre-line text-destructive">
                <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  {t(
                    noCred.hint === "ghMissing"
                      ? "createRepo.erro.noCredentialGhMissing"
                      : "createRepo.erro.noCredential",
                  )}
                </span>
              </div>
              <div className="border-t border-border bg-muted/40 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    <TerminalIcon className="size-3" />
                    {t("createRepo.comandos.rotulo")}
                  </span>
                  <button
                    type="button"
                    onClick={() => void copiarComandos()}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {copiado ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                    {copiado ? t("createRepo.comandos.copiado") : t("createRepo.comandos.copiar")}
                  </button>
                </div>
                {linhasComando.map((linha) => (
                  <div key={linha} className="px-1 py-0.5 font-mono text-[11px] leading-relaxed">
                    <span className="text-muted-foreground select-none">$ </span>
                    {linha}
                  </div>
                ))}
                <div className="mt-1 px-1">
                  <a
                    href="https://cli.github.com"
                    rel="noreferrer"
                    target="_blank"
                    className="text-[10px] text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                  >
                    {t("createRepo.comandos.outros")}
                  </a>
                </div>
              </div>
              <p className="border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground">
                {t("createRepo.erro.detalhe")}: {montarDetalhe()}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={criando} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!nomeValido || criando}
            onClick={() => void criar()}
          >
            {criando ? t("createRepo.criando") : t("createRepo.criar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}