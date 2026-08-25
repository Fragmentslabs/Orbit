import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, SearchIcon } from "lucide-react"

import type { Task } from "@shared/esteira"
import { cn } from "@/lib/utils"

/**
 * Conteúdo de um seletor de tasks: campo de busca no topo e a listagem
 * filtrada abaixo. Fica separado porque dois lugares precisam exatamente
 * disto — o seletor de dependências da criação (múltipla escolha) e o
 * "adicionar dependência" do modal da task (escolha simples).
 *
 * O estado da busca vive aqui: o PopoverContent desmonta ao fechar, então ele
 * zera sozinho na próxima abertura.
 */
export function ListaTasksBuscavel({ tasks, selecionadas, onEscolher }: {
  tasks: Task[]
  /**
   * Ids já marcados — desenha a caixa de seleção. Ausente = escolha simples,
   * sem caixa, para quando o clique já resolve a ação.
   */
  selecionadas?: string[]
  onEscolher: (id: string) => void
}) {
  const { t } = useTranslation()
  const [busca, setBusca] = useState("")

  const filtradas = useMemo(() => {
    const alvo = busca.trim().toLowerCase()
    if (!alvo) return tasks
    return tasks.filter((task) => task.titulo.toLowerCase().includes(alvo))
  }, [tasks, busca])

  return (
    <>
      <div className="flex items-center gap-1.5 border-b px-2">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("esteira.buscarTask")}
          className="h-8 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {filtradas.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            {t("esteira.nenhumaTask")}
          </p>
        ) : (
          filtradas.map((task) => {
            const marcada = selecionadas?.includes(task.id) ?? false
            return (
              <button
                key={task.id}
                type="button"
                onClick={() => onEscolher(task.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                {selecionadas && (
                  <span
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
                      marcada && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {marcada && <CheckIcon className="size-2.5" />}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{task.titulo}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {t(`esteira.status.${task.status}`)}
                </span>
              </button>
            )
          })
        )}
      </div>
    </>
  )
}
