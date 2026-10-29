import { create } from 'zustand'

/**
 * Folha da memória citada na conversa — o equivalente mobile do painel
 * lateral do desktop, onde não há hover nem painel: tocar no chip abre um
 * resumo aqui mesmo, com o caminho para a tela completa.
 *
 * Mora num store (e não no estado do componente) porque o chip é desenhado
 * DENTRO de um <Text> do markdown: não dá para montar um <Modal> ali, e a
 * folha precisa ser única na tela — vários chips citados numa resposta não
 * podem empilhar vários modais.
 */
interface MemorySheetState {
  /** Memória aberta na folha; null = fechada. */
  memoryId: string | null
  open: (id: string) => void
  close: () => void
}

export const useMemorySheetStore = create<MemorySheetState>((set) => ({
  memoryId: null,
  open: (id) => set({ memoryId: id }),
  close: () => set({ memoryId: null }),
}))
