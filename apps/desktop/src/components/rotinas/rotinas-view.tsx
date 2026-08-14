import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { rotinasApi } from "@/src/lib/ipc"
import { useRotinasStore } from "@/src/stores/rotinas-store"
import { useSessionStore } from "@/src/stores/session-store"
import { CriarRotinaDialog } from "./criar-rotina-dialog"
import { DetalheDaRotina, ListaDeRotinas } from "./minhas-rotinas"

/**
 * Página Rotinas (modo código, na sidebar). Dois níveis, como a esteira:
 *
 *   lista de rotinas  →  [abrir]  →  detalhe da rotina (sessões executadas)
 *
 * A criação é um MODAL, não uma aba: a página é a lista, e criar é uma ação
 * sobre ela. No detalhe o header da listagem some — quem está ali está dentro
 * de UMA rotina, e o header é o dela.
 */
export function RotinasView() {
  const { t } = useTranslation()
  const carregado = useRotinasStore((s) => s.carregado)
  const carregar = useRotinasStore((s) => s.carregar)
  const rotinas = useRotinasStore((s) => s.rotinas)
  const podar = useRotinasStore((s) => s.podar)
  const abertaId = useRotinasStore((s) => s.abertaId)
  const setAberta = useRotinasStore((s) => s.setAberta)
  const sessions = useSessionStore((s) => s.sessions)
  const sessoesCarregadas = useSessionStore((s) => s.initialized)
  const [criarAberto, setCriarAberto] = useState(false)

  const aberta = abertaId ? rotinas.find((r) => r.id === abertaId) : undefined

  useEffect(() => {
    if (!carregado) void carregar()
  }, [carregado, carregar])

  // Eventos do scheduler: execução começando/terminando, ultimaExecucao
  // avançando, rotina criada ou excluída em outra janela.
  useEffect(() => rotinasApi.onEvent((evento) => useRotinasStore.getState().aplicarEvento(evento)), [])

  // Rotina removida (aqui ou em outra janela): volta para a lista em vez de
  // deixar a tela presa num detalhe que não existe mais.
  useEffect(() => {
    if (abertaId && carregado && !aberta) setAberta(null)
  }, [abertaId, carregado, aberta, setAberta])

  /**
   * Poda das métricas órfãs. A sessão de uma execução pode ter sido excluída
   * pela sidebar (aqui ou em outra janela) — como a lista é derivada das
   * sessões, o registro sobrevivente seria invisível e eterno. Rodar na
   * abertura da página cobre os dois casos com uma regra só.
   */
  useEffect(() => {
    if (!carregado || !sessoesCarregadas) return
    void podar(sessions.map((s) => s.id))
    // Só na abertura/carga: podar a cada mudança de sessions faria uma
    // gravação em disco a cada mensagem recebida.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carregado, sessoesCarregadas])

  if (!carregado) {
    return <p className="p-6 text-center text-xs text-muted-foreground">{t("rotinas.carregando")}</p>
  }

  if (aberta) {
    return <DetalheDaRotina rotina={aberta} onVoltar={() => setAberta(null)} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Sem rotina nenhuma a tela é só o estado vazio com a chamada para
          criar — um header com botão em cima de "nada aqui" seria redundante. */}
      {rotinas.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 pb-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{t("rotinas.titulo")}</h2>
            <p className="text-xs text-muted-foreground">{t("rotinas.subtitulo")}</p>
          </div>
          <Button size="lg" onClick={() => setCriarAberto(true)}>
            <PlusIcon className="size-4" />
            {t("rotinas.lista.nova")}
          </Button>
        </div>
      )}

      <ListaDeRotinas onCriarNova={() => setCriarAberto(true)} />

      <CriarRotinaDialog
        aberto={criarAberto}
        onOpenChange={setCriarAberto}
        onCriada={(id) => setAberta(id)}
      />
    </div>
  )
}
