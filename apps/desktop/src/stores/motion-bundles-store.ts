import { useEffect, useMemo, useRef } from "react"
import { create } from "zustand"
import type { ChatMessage } from "@shared/chat"
import type { MotionBundle } from "@shared/media"
import { motionApi } from "@/src/lib/ipc"
import {
  NO_BUNDLES,
  indexMotionBundles,
  motionBundleAnchors,
  type MotionBundleIndexes,
} from "@/src/lib/motion-bundle"

/**
 * Os cards de peça de motion da conversa, do lado de quem desenha o chat.
 *
 * A lista de arquivos é do MAIN (a pasta da peça é dele): aqui ficam o cache
 * por conversa, o mapa que liga um `aud_…`/`img_…` à peça dona e o endereço do
 * card — a PRIMEIRA mensagem que mostrou mídia daquela peça, que é onde ele
 * mora para sempre. Quem decide o que fazer com cada parte é `motion-bundle`.
 *
 * Por que um store e não estado da mensagem: o card precisa se atualizar quando
 * a PASTA muda (uma narração regravada, um arquivo novo), e a mensagem antiga
 * não é re-renderizada por isso — ela é memoizada. Quem assina o store é o card.
 */

interface SessionBundles {
  bundles: MotionBundle[]
  /** motionId → id da mensagem onde o card mora. */
  anchors: Record<string, string>
}

interface MotionBundlesState {
  bySession: Record<string, SessionBundles>
  load: (sessionId: string) => Promise<void>
  setAnchors: (sessionId: string, anchors: Record<string, string>) => void
}

const EMPTY: SessionBundles = { bundles: [], anchors: {} }
/** Uma carga por vez por conversa: a pasta avisa a cada arquivo copiado. */
const inFlight = new Set<string>()
/** Pedidos que chegaram durante uma carga: a última roda quando ela termina. */
const queued = new Set<string>()

async function loadBundles(
  sessionId: string,
  set: (fn: (state: MotionBundlesState) => Partial<MotionBundlesState>) => void,
  get: () => MotionBundlesState,
): Promise<void> {
  if (inFlight.has(sessionId)) {
    // Não perde o aviso: sem a repetição, o fim de um turno que coincidisse
    // com uma carga em curso deixaria o card com a lista de antes.
    queued.add(sessionId)
    return
  }
  inFlight.add(sessionId)
  try {
    const bundles = await motionApi.bundles(sessionId)
    // Preserva os endereços já calculados: são das MENSAGENS, não da pasta.
    const anchors = get().bySession[sessionId]?.anchors ?? {}
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: { bundles, anchors } } }))
  } catch {
    // Sem a lista o chat continua exatamente como era (os players soltos):
    // o card é uma melhora da conversa, não uma dependência dela.
  } finally {
    inFlight.delete(sessionId)
    if (queued.delete(sessionId)) void loadBundles(sessionId, set, get)
  }
}

export const useMotionBundlesStore = create<MotionBundlesState>((set, get) => ({
  bySession: {},
  load: async (sessionId: string) => {
    if (!sessionId) return
    await loadBundles(sessionId, set, get)
  },
  setAnchors: (sessionId: string, anchors: Record<string, string>) => {
    const current = get().bySession[sessionId]
    const before = current?.anchors ?? {}
    const same =
      Object.keys(before).length === Object.keys(anchors).length &&
      Object.entries(anchors).every(([id, messageId]) => before[id] === messageId)
    if (same && current) return
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: { bundles: state.bySession[sessionId]?.bundles ?? [], anchors },
      },
    }))
  },
}))

/** Os dados de uma conversa (identidade estável enquanto nada muda). */
export function useSessionBundles(sessionId?: string): SessionBundles {
  return useMotionBundlesStore((state) => (sessionId ? state.bySession[sessionId] ?? EMPTY : EMPTY))
}

/** O mapa chave → peça + onde cada card mora, pronto para as partes. */
export function useMotionBundleIndexes(sessionId?: string): MotionBundleIndexes {
  const data = useSessionBundles(sessionId)
  return useMemo(
    () => (data === EMPTY ? NO_BUNDLES : indexMotionBundles(data.bundles, data.anchors)),
    [data],
  )
}

/**
 * Mantém a lista e os endereços em dia para a conversa aberta.
 *
 * Três gatilhos, e nenhum deles é "a cada delta do stream": ao abrir a conversa,
 * quando o turno TERMINA (foi quando a pasta cresceu) e quando o main avisa que
 * a pasta de alguma peça mudou (o arquivo foi reescrito, a mídia entrou). Os
 * endereços são recalculados quando as mensagens mudam, a custo de uma varredura
 * de partes — só as de mídia dão trabalho.
 */
export function useMotionBundleAnchors(
  sessionId: string | undefined,
  messages: ChatMessage[],
  isBusy: boolean,
): void {
  const data = useSessionBundles(sessionId)
  const load = useMotionBundlesStore((state) => state.load)
  const setAnchors = useMotionBundlesStore((state) => state.setAnchors)
  const bundles = data.bundles

  useEffect(() => {
    if (!sessionId) return
    void load(sessionId)
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = motionApi.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(sessionId), 250)
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [sessionId, load])

  const wasBusy = useRef(isBusy)
  useEffect(() => {
    const finished = wasBusy.current && !isBusy
    wasBusy.current = isBusy
    if (finished && sessionId) void load(sessionId)
  }, [isBusy, sessionId, load])

  // A varredura das mensagens é O(partes): refazê-la a cada token do stream
  // seria trabalho jogado fora. Âncora só nasce quando aparece mídia nova — e
  // mídia nova muda a ÚLTIMA mensagem (é nela que o stream escreve). O id entra
  // na impressão digital porque regerar troca a mensagem por outra.
  const last = messages[messages.length - 1]
  const fingerprint = `${messages.length}:${last?.id ?? ""}:${last?.parts.length ?? 0}`
  const latest = useRef(messages)
  latest.current = messages
  useEffect(() => {
    if (!sessionId) return
    const byKey = bundles.length ? indexMotionBundles(bundles, {}).byKey : null
    setAnchors(sessionId, byKey ? motionBundleAnchors(latest.current, byKey) : {})
  }, [sessionId, fingerprint, bundles, setAnchors])
}
