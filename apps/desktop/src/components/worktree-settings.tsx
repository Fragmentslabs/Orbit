import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon, FolderGit2, FolderOpenIcon } from "lucide-react"
import type { LocalWorktrees } from "@shared/app-settings"
import type { ValidacaoPastaWorktrees } from "@shared/worktrees"
import { SettingRow, SettingSelect } from "@/src/components/settings-row"
import { worktreeApi } from "@/src/lib/ipc"
import { useAppSettings } from "@/src/stores/app-settings"

async function escolherPasta(): Promise<string | null> {
  try {
    return (await window.ipcRenderer.invoke("select-folder")) as string | null
  } catch {
    return null
  }
}

/**
 * Preferências → modo código: onde os worktrees criados pelo Orbit (chats e
 * tasks da esteira) ficam. Muda só para os novos — os existentes continuam
 * onde estão, porque o git guarda o caminho de cada um.
 */
export function WorktreeSettings() {
  const { t } = useTranslation()
  const worktrees = useAppSettings((s) => s.settings.worktrees)
  const update = useAppSettings((s) => s.update)
  const [validacao, setValidacao] = useState<ValidacaoPastaWorktrees | null>(null)
  const [recusada, setRecusada] = useState<string | null>(null)

  /**
   * Pasta dentro de um repositório é recusada: os worktrees entrariam nas
   * buscas e no status dele, e quem quer isso tem a opção "Dentro do projeto"
   * (que tira a pasta do git sozinha).
   */
  const aplicarPasta = async (pasta: string) => {
    const v = await worktreeApi.validarPasta(pasta)
    if (v.dentroDeRepositorio) {
      setRecusada(pasta)
      return
    }
    setRecusada(null)
    update({ worktrees: { local: "personalizada", pasta } })
  }

  // Confere a pasta personalizada sempre que ela muda (e ao abrir, porque o
  // disco pode ter sido desconectado desde a escolha).
  useEffect(() => {
    if (worktrees.local !== "personalizada" || !worktrees.pasta) {
      setValidacao(null)
      return
    }
    let vivo = true
    void worktreeApi.validarPasta(worktrees.pasta).then((v) => vivo && setValidacao(v))
    return () => {
      vivo = false
    }
  }, [worktrees.local, worktrees.pasta])

  const trocarLocal = async (local: LocalWorktrees) => {
    setRecusada(null)
    if (local !== "personalizada") {
      update({ worktrees: { local, pasta: worktrees.pasta } })
      return
    }
    // Personalizada sem pasta não tem para onde ir: escolhe na hora; cancelar
    // mantém o que estava.
    const pasta = worktrees.pasta ?? (await escolherPasta())
    if (pasta) await aplicarPasta(pasta)
  }

  const trocarPasta = async () => {
    const pasta = await escolherPasta()
    if (pasta) await aplicarPasta(pasta)
  }

  return (
    <div className="space-y-2">
      <SettingRow icon={FolderGit2} title={t("worktreeSettings.title")} description={t("worktreeSettings.description")}>
        <SettingSelect<LocalWorktrees>
          value={worktrees.local}
          onChange={(v) => void trocarLocal(v)}
          options={[
            { value: "padrao", label: t("worktreeSettings.padrao") },
            { value: "projeto", label: t("worktreeSettings.projeto") },
            { value: "personalizada", label: t("worktreeSettings.personalizada") },
          ]}
        />
      </SettingRow>

      <p className="px-1 text-[11px] leading-tight text-muted-foreground">
        {worktrees.local === "padrao"
          ? t("worktreeSettings.dicaPadrao")
          : worktrees.local === "projeto"
            ? t("worktreeSettings.dicaProjeto")
            : t("worktreeSettings.dicaPersonalizada")}
      </p>

      {recusada && (
        <div className="px-1">
          <Aviso texto={t("worktreeSettings.recusadaRepositorio", { pasta: recusada })} />
        </div>
      )}

      {worktrees.local === "personalizada" && worktrees.pasta && (
        <div className="space-y-1.5 px-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px]" title={worktrees.pasta}>
              {worktrees.pasta}
            </span>
            <button
              type="button"
              onClick={() => void trocarPasta()}
              className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-accent"
            >
              <FolderOpenIcon className="size-3" />
              {t("worktreeSettings.escolher")}
            </button>
          </div>
          {validacao && !validacao.existe && <Aviso texto={t("worktreeSettings.naoExiste")} />}
          {validacao?.dentroDeRepositorio && <Aviso texto={t("worktreeSettings.dentroDeRepositorio")} />}
          {validacao?.outroDisco && <Aviso texto={t("worktreeSettings.outroDisco")} />}
        </div>
      )}
    </div>
  )
}

function Aviso({ texto }: { texto: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2 py-1.5 text-[11px] text-yellow-700 dark:text-yellow-300">
      <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
      {texto}
    </p>
  )
}
