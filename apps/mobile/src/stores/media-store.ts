import { create } from 'zustand'
import type { MediaEntry, MediaUsage } from '@orbit/shared'
import { useConnectionStore } from './connection-store'

/**
 * Registry de mídia no desktop (orbit-data/media) lido via HTTP do companion.
 *
 * A galeria do mobile não tem acesso ao filesystem do desktop — as entradas
 * vêm do endpoint /api/media com `url` já assinada (token na query) pronta para
 * o <Image> nativo. O escopo por modo (chat vs código) é aplicado na tela,
 * usando as sessões locais, igual ao desktop.
 */

interface MediaState {
  entries: MediaEntry[]
  usage: MediaUsage
  loading: boolean
  refreshing: boolean

  /** Busca a lista e o uso do registry no desktop. */
  refresh: () => Promise<void>
  /** Remove várias imagens (seleção em lote) e recarrega. */
  remove: (ids: string[]) => Promise<void>
  /** Remove uma imagem e recarrega. */
  removeOne: (id: string) => Promise<void>
}

export const useMediaStore = create<MediaState>((set, get) => ({
  entries: [],
  usage: { count: 0, bytes: 0 },
  loading: true,
  refreshing: false,

  refresh: async () => {
    const http = useConnectionStore.getState().http
    if (!http) {
      set({ loading: false, refreshing: false })
      return
    }
    const hasData = get().entries.length > 0
    if (hasData) set({ refreshing: true })
    else set({ loading: true })

    try {
      const [list, usage] = await Promise.all([http.listMedia(), http.mediaUsage()])
      set({
        entries: list.ok && Array.isArray(list.data) ? list.data : get().entries,
        usage: usage.ok && usage.data ? usage.data : get().usage,
      })
    } catch {
      // melhor-esforço — mantém o que já estava na tela
    } finally {
      set({ loading: false, refreshing: false })
    }
  },

  remove: async (ids) => {
    const http = useConnectionStore.getState().http
    if (!http || ids.length === 0) return
    await http.deleteManyMedia(ids)
    await get().refresh()
  },

  removeOne: async (id) => {
    const http = useConnectionStore.getState().http
    if (!http) return
    await http.deleteMedia(id)
    await get().refresh()
  },
}))
