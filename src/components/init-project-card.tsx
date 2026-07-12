import { useEffect } from "react"
import { CheckCircle2, FolderSearch, Loader2, X, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { PROJECT_AREAS } from "@/shared/memory"
import { subscribeInitEvents, useInitStore } from "@/src/stores/init-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Card de boas-vindas do modo código: aparece quando a pasta aberta é um
 * projeto novo (nenhum chat anterior a referencia como diretório principal e
 * não há memórias de init). Clicável — é o único fluxo em card; o equivalente
 * textual é o comando /init no palette.
 */

const STAGE_LABEL: Record<string, string> = {
  scanning: "Escaneando estrutura e configs…",
  exploring: "Subagents explorando o código…",
  generating: "Revisando levantamentos e dividindo em memórias…",
  saving: "Salvando memórias do projeto…",
}

export function InitProjectCard({ directory, sessionId }: {
  directory: string
  /** Sessão atual — excluída da checagem de "primeiro chat da pasta" */
  sessionId?: string
}) {
  const sessions = useSessionStore((s) => s.sessions)
  const progress = useInitStore((s) => s.progress[directory])
  const initialized = useInitStore((s) => s.initialized[directory])
  const dismissed = useInitStore((s) => s.dismissed.includes(directory))
  const check = useInitStore((s) => s.check)
  const run = useInitStore((s) => s.run)
  const dismiss = useInitStore((s) => s.dismiss)
  const clearProgress = useInitStore((s) => s.clearProgress)

  useEffect(() => {
    subscribeInitEvents()
    void check(directory)
  }, [directory, check])

  // "Projeto novo" = nenhuma outra sessão usa esta pasta como principal
  const hasPreviousChat = sessions.some(
    (s) => s.id !== sessionId && s.directory === directory,
  )

  const busy =
    progress &&
    (progress.stage === "scanning" ||
      progress.stage === "exploring" ||
      progress.stage === "generating" ||
      progress.stage === "saving")

  // Sem progresso ativo: só mostra a oferta para projeto realmente novo
  if (!progress && (dismissed || hasPreviousChat || initialized !== false)) return null

  return (
    <div className="rounded-xl border bg-card p-3 text-sm shadow-sm">
      {!progress ? (
        <div className="flex items-start gap-3">
          <FolderSearch className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Projeto novo por aqui</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Posso analisar a estrutura e gerar memórias por área (stack, arquitetura,
              design, regras de negócio…) para ganhar contexto de uma vez — em vez de
              descobrir tudo por tentativa e erro.
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" className="h-7 text-xs" onClick={() => void run(directory)}>
                Analisar projeto
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => dismiss(directory)}
              >
                Agora não
              </Button>
            </div>
          </div>
        </div>
      ) : busy ? (
        <div className="flex items-center gap-3">
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-xs">{STAGE_LABEL[progress.stage] ?? "Analisando projeto…"}</p>
            {progress.stage === "exploring" && progress.progress && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {progress.progress.done}/{progress.progress.total} áreas
                {progress.progress.area && ` · última: ${PROJECT_AREAS[progress.progress.area]?.label ?? progress.progress.area}`}
              </p>
            )}
          </div>
        </div>
      ) : progress.stage === "done" ? (
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Projeto analisado</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Memórias criadas: {(progress.areas ?? []).map((a) => PROJECT_AREAS[a]?.label ?? a).join(", ")}.
              Elas ficam na aba Memórias e entram no contexto conforme a tarefa.
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => clearProgress(directory)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">A análise falhou</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{progress.error}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void run(directory)}>
                Tentar de novo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => clearProgress(directory)}
              >
                Fechar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
