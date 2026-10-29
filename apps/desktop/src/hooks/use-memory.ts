import { useEffect, useMemo } from "react"
import type { Memory } from "@shared/memory"
import { useMemoryStore } from "@/src/stores/memory-store"

/**
 * Uma memória do índice, com carregamento sob demanda.
 *
 * O índice da tela de Memórias pode nunca ter sido carregado dentro de uma
 * conversa — o chip da citação é a primeira coisa que pede uma memória. Sem o
 * initialize() aqui, todo chip nasceria "não encontrada". Ele é idempotente:
 * se o índice já veio, não há nova chamada.
 */
export function useMemoryById(id: string | undefined): Memory | undefined {
  const index = useMemoryStore((s) => s.index)
  const initialize = useMemoryStore((s) => s.initialize)
  const memory = useMemo(() => (id ? index.find((m) => m.id === id) : undefined), [index, id])

  useEffect(() => {
    if (id && !memory) void initialize()
  }, [id, memory, initialize])

  return memory
}
