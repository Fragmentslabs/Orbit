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

/** Mirrors the raw details of the main process (electron/lib/github-repo.ts). */
type GitCredDetail = {
  mode: "exit" | "spawn" | "timeout"
  code: number | null
  output: string
}

type GhCredDetail = {
  status: "missing" | "other"
  output: string
}

/** Mirrors CreateRepoResult from the main (electron/lib/github-repo.ts). */
type CreateRepoResult =
  | { ok: true; url: string; fullName: string; pushed: boolean }
  | {
      ok: false
      kind: "noCredential"
      hint: "ghMissing" | "ghOther"
      detail: { git: GitCredDetail; gh: GhCredDetail }
    }
  | { ok: false; kind: "auth" | "nameTaken" | "invalidName" | "noCommits" | "other"; message: string }

/** Same rule as the main process — validating here avoids a pointless trip to the API. */
function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== "." && name !== ".."
}

/**
 * GitHub CLI installation command per system — the same command as the official
 * guide (cli.github.com). Platforms outside the map fall into the link line,
 * which points to the guide; `gh auth login` is common to all of them.
 */
const INSTALL_CMD: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "brew install gh",
  win32: "winget install --id GitHub.cli",
  linux: "sudo apt install gh",
}

/**
 * Opened when "send" fails for lack of a remote: it explains the situation and
 * offers to create the repository on GitHub right there.
 *
 * The token is neither requested nor pasted — it comes from the git credential helper or from the
 * GitHub CLI. If there is no credential, the error instructs how to install/authenticate
 * `gh` (the message varies according to whether it exists on the machine, through the main process hint),
 * with the right command for the system and a copy button; the technical detail
 * of the git helper stays in the last line.
 */
export function CreateRemoteRepoDialog({ repoPath, open, onOpenChange, onCreated }: {
  repoPath: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after creating — the parent reloads the commit list and the git state. */
  onCreated: (result: Extract<CreateRepoResult, { ok: true }>) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [isPrivate, setIsPrivate] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** No credential: keeps the main process hint and the raw details (translated at render time). */
  const [noCred, setNoCred] = useState<{
    hint: "ghMissing" | "ghOther"
    detail: { git: GitCredDetail; gh: GhCredDetail }
  } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    // Suggests the folder name, which is what the user almost always wants.
    const base = repoPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
    setName(base.replace(/[^A-Za-z0-9._-]/g, "-"))
    setIsPrivate(true)
    setError(null)
    setNoCred(null)
    setCopied(false)
    setCreating(false)
  }, [open, repoPath])

  const validName = isValidRepoName(name.trim())

  const create = async () => {
    if (!validName || creating) return
    setCreating(true)
    setError(null)
    setNoCred(null)
    const result = (await window.ipcRenderer.invoke(
      "git:createRemoteRepo",
      repoPath,
      name.trim(),
      isPrivate,
    )) as CreateRepoResult
    setCreating(false)
    if (result.ok) {
      onCreated(result)
      onOpenChange(false)
      return
    }
    // With no credential there is no token to type: the instruction is to install/authenticate
    // the GitHub CLI (the message varies if gh exists on the machine, through the main
    // process hint), with the right command for the system and the technical detail apart.
    if (result.kind === "noCredential") {
      setNoCred({ hint: result.hint, detail: result.detail })
      return
    }
    if (result.kind === "auth") {
      setError(`${t("createRepo.error.auth")}\n${result.message}`)
      return
    }
    const known = ["nameTaken", "invalidName", "noCommits"]
    setError(
      known.includes(result.kind)
        ? t(`createRepo.error.${result.kind}`)
        : `${t("createRepo.error.other")}\n${result.message}`,
    )
  }

  /** Commands that unblock the creation, in a single step. */
  const commandLines: string[] = []
  if (noCred?.hint === "ghMissing") {
    const install = INSTALL_CMD[window.platform]
    commandLines.push(...(install ? [install, "gh auth login"] : ["gh auth login"]))
  } else if (noCred) {
    commandLines.push("gh auth login")
  }

  /**
   * Builds the technical detail in the UI language. The raw outputs of the tools
   * (git stderr, gh stderr) are shown without translation — only the frame
   * ("git exited with N", "gh not found…") is localized.
   */
  const buildDetail = () => {
    if (!noCred) return ""
    const gitKey = ({
      exit: "createRepo.error.detailGitExit",
      spawn: "createRepo.error.detailGitSpawn",
      timeout: "createRepo.error.detailGitTimeout",
    } as const)[noCred.detail.git.mode]
    const parts: string[] = []
    const gitBase = t(gitKey, { code: noCred.detail.git.code ?? 0 })
    parts.push(noCred.detail.git.output ? `${gitBase}: ${noCred.detail.git.output}` : gitBase)
    if (noCred.detail.gh.status === "missing") {
      parts.push(t("createRepo.error.detailGhMissing"))
    } else {
      parts.push(
        noCred.detail.gh.output
          ? `${t("createRepo.error.detailGhFailed")}: ${noCred.detail.gh.output}`
          : t("createRepo.error.detailGhNoToken"),
      )
    }
    return parts.join("; ")
  }

  const copyCommands = async () => {
    await navigator.clipboard.writeText(commandLines.join(" && "))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !creating && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <CloudUploadIcon className="size-4" />
            {t("createRepo.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{t("createRepo.description")}</p>

          <div>
            <p className="mb-1 text-xs font-medium">{t("createRepo.nameLabel")}</p>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create()
              }}
              placeholder={t("createRepo.namePlaceholder")}
              disabled={creating}
            />
            {name.trim() !== "" && !validName && (
              <p className="mt-1 text-[11px] text-destructive">{t("createRepo.invalidName")}</p>
            )}
          </div>

          {/* Private by default: creating a public repository by accident exposes
              the code, and the way back is manual. */}
          <div className="flex gap-1.5">
            {([true, false] as const).map((option) => (
              <button
                key={String(option)}
                type="button"
                disabled={creating}
                onClick={() => setIsPrivate(option)}
                className={cn(
                  "flex flex-1 items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors",
                  isPrivate === option ? "border-primary bg-primary/10" : "hover:bg-accent",
                )}
              >
                {option ? <LockIcon className="size-3" /> : <GlobeIcon className="size-3" />}
                {t(option ? "createRepo.private" : "createRepo.public")}
              </button>
            ))}
          </div>

          {error && (
            <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] whitespace-pre-line text-destructive">
              <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
            </p>
          )}

          {noCred && (
            <div className="overflow-hidden rounded-md border border-border">
              <div className="flex items-start gap-1.5 bg-destructive/10 p-2 text-[11px] whitespace-pre-line text-destructive">
                <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  {t(
                    noCred.hint === "ghMissing"
                      ? "createRepo.error.noCredentialGhMissing"
                      : "createRepo.error.noCredential",
                  )}
                </span>
              </div>
              <div className="border-t border-border bg-muted/40 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    <TerminalIcon className="size-3" />
                    {t("createRepo.commands.label")}
                  </span>
                  <button
                    type="button"
                    onClick={() => void copyCommands()}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                    {copied ? t("createRepo.commands.copied") : t("createRepo.commands.copy")}
                  </button>
                </div>
                {commandLines.map((line) => (
                  <div key={line} className="px-1 py-0.5 font-mono text-[11px] leading-relaxed">
                    <span className="text-muted-foreground select-none">$ </span>
                    {line}
                  </div>
                ))}
                <div className="mt-1 px-1">
                  <a
                    href="https://cli.github.com"
                    rel="noreferrer"
                    target="_blank"
                    className="text-[10px] text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                  >
                    {t("createRepo.commands.others")}
                  </a>
                </div>
              </div>
              <p className="border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground">
                {t("createRepo.error.detail")}: {buildDetail()}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={creating} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!validName || creating}
            onClick={() => void create()}
          >
            {creating ? t("createRepo.creating") : t("createRepo.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}