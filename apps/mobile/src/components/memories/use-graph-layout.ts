import { useEffect, useMemo, useState } from 'react'
import { InteractionManager } from 'react-native'
import type { Memory } from '@orbit/shared'
import { layoutMemoryGraph } from '@orbit/shared'
import type { MemoryLayout } from '@orbit/shared'

/**
 * Layout do grafo fora do caminho crítico da navegação, com cache entre
 * montagens.
 *
 * `layoutMemoryGraph` roda simulação de forças e duas passadas de separação —
 * todas O(n²) sobre os nós (320 iterações + 90 + 60 no pior caso). Com algumas
 * centenas de memórias isso é trabalho de segundo inteiro na thread de JS, e
 * era feito no primeiro render: a tela travava ao abrir e travava de novo a
 * cada volta para a aba do grafo.
 *
 * Aqui ele espera as interações (transição da tela) terminarem e o resultado
 * fica em cache pela assinatura do pool — reabrir a aba não recalcula nada.
 */

interface Cache {
  chave: string
  layout: MemoryLayout
  now: number
}

// Uma entrada só: o pool muda inteiro quando o filtro muda, e guardar layouts
// antigos seria segurar centenas de nós na memória sem ninguém pedindo.
let cache: Cache | null = null

/** Assinatura barata do pool: o layout só depende de quem está nele e das
 *  ligações declaradas. */
function assinatura(pool: Memory[]): string {
  let chave = `${pool.length}`
  for (const memory of pool) chave += `|${memory.id}:${memory.relatedIds.length}`
  return chave
}

export interface GraphLayoutState {
  layout: MemoryLayout | null
  /** Momento em que o layout foi montado — "recente"/"esquecida" são relativos
   *  a ele, e não ao frame atual (senão o memo da cena morria a cada frame). */
  now: number
}

export function useGraphLayout(pool: Memory[]): GraphLayoutState {
  // Memoizado: sem isto a assinatura seria remontada a cada render do grafo —
  // inclusive nos frames de pan/pinch, que é justamente onde não pode haver
  // trabalho proporcional ao número de memórias.
  const chave = useMemo(() => assinatura(pool), [pool])
  const [estado, setEstado] = useState<GraphLayoutState>(() =>
    cache?.chave === chave ? { layout: cache.layout, now: cache.now } : { layout: null, now: 0 },
  )

  useEffect(() => {
    if (cache?.chave === chave) {
      // O inicializador do state já pegou este layout quando o cache existia na
      // montagem; só entra aqui quando a chave mudou para uma já em cache.
      const atual = cache
      setEstado((anterior) =>
        anterior.layout === atual.layout ? anterior : { layout: atual.layout, now: atual.now },
      )
      return
    }
    setEstado({ layout: null, now: 0 })
    let vivo = true
    const tarefa = InteractionManager.runAfterInteractions(() => {
      if (!vivo) return
      const layout = layoutMemoryGraph(pool, { inferEdges: true })
      const now = Date.now()
      cache = { chave, layout, now }
      if (vivo) setEstado({ layout, now })
    })
    return () => {
      vivo = false
      tarefa.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a chave resume o pool
  }, [chave])

  return estado
}
