import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { FolderSearch } from "lucide-react"

import { Button } from "@/components/ui/button"
import { subscribeInitEvents, useInitStore } from "@/src/stores/init-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Card de boas-vindas do modo código: aparece quando a pasta aberta é um
 * projeto novo (nenhum chat anterior a referencia como diretório principal e
 * não há memórias de init). Clicável — cria uma nova sessão que envia /init.
 * A partir daí o progresso é acompanhado na conversa, não no card.
 */

export function InitProjectCard({ directory, sessionId }: {
  directory: string
  sessionId?: string
}) {
  const { t } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const initialized = useInitStore((s) => s.initialized[directory])
  const dismissed = useInitStore((s) => s.dismissed.includes(directory))
  const check = useInitStore((s) => s.check)
  const dismiss = useInitStore((s) => s.dismiss)

  const createSession = useSessionStore((s) => s.createSession)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const selectSession = useSessionStore((s) => s.selectSession)

  useEffect(() => {
    subscribeInitEvents()
    void check(directory)
  }, [directory, check])

  const hasPreviousChat = sessions.some(
    (s) => s.id !== sessionId && s.directory === directory,
  )

  if (dismissed || hasPreviousChat || initialized !== false) return null

  const handleAnalyze = async () => {
    dismiss(directory)
    const session = await createSession("code", { directory })
    await sendMessage("code", "/init", { options: { initMode: true }, sessionId: session.id, directory })
    selectSession("code", session.id)
  }

  return (
    <div className="rounded-xl border bg-card p-3 text-sm shadow-sm">
      <div className="flex items-start gap-3">
        <FolderSearch className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t("initProject.title")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("initProject.description")}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" className="h-7 text-xs" onClick={handleAnalyze}>
              {t("initProject.analyze")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => dismiss(directory)}
            >
              {t("initProject.later")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
