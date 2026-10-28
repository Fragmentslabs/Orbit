import type { ChatMessage, MessagePart } from "@shared/chat"
import { motionBundleKey, type MotionBundle } from "@shared/media"

/**
 * O que fazer com as mídias de uma mensagem quando elas são de uma PEÇA.
 *
 * Enquanto o agente constrói uma composição, cada áudio e cada imagem que ele
 * gera vira um player solto na conversa — inclusive o que depois foi trocado.
 * A peça tem um card só, e os players dela passam a ser LINHAS desse card. Este
 * módulo é a conta, pura e testável: dada a mensagem, as peças da conversa e
 * onde cada card mora, dizer qual parte vira card, qual some e qual continua
 * sendo o player de sempre.
 *
 * Nada é gravado na mensagem: a ligação sai do ARQUIVO — a peça guardou de qual
 * `aud_…`/`img_…` cada arquivo dela veio (ver motion-files no main), e a part
 * carrega o mesmo id na URL. Assim uma conversa antiga, gravada antes disto
 * existir, já aparece agrupada.
 */

export interface MotionBundleIndexes {
  /** Chave de mídia (`aud_x.wav`, o caminho de um vídeo) → peça dona. */
  byKey: Map<string, MotionBundle>
  /** motionId → id da mensagem onde o card aparece (a primeira com mídia dela). */
  anchors: Record<string, string>
}

export const NO_BUNDLES: MotionBundleIndexes = { byKey: new Map(), anchors: {} }

export function indexMotionBundles(
  bundles: MotionBundle[],
  anchors: Record<string, string>,
): MotionBundleIndexes {
  const byKey = new Map<string, MotionBundle>()
  for (const bundle of bundles) {
    for (const key of bundle.keys) {
      // A primeira peça que reivindica a chave é a dona: um mesmo arquivo
      // copiado para duas peças aparece no card daquela em que ele nasceu.
      if (!byKey.has(key)) byKey.set(key, bundle)
    }
  }
  return { byKey, anchors }
}

/** A peça a que esta mídia pertence — ou `null` se ela não é de peça nenhuma. */
export function bundleOfPart(
  part: MessagePart,
  byKey: Map<string, MotionBundle>,
): MotionBundle | null {
  if (!byKey.size) return null
  if (part.type === "audio" || part.type === "image") {
    const key = motionBundleKey(part.src)
    return key ? byKey.get(key) ?? null : null
  }
  if (part.type === "video") {
    // Vídeo tem duas identidades: a URL do registro e o caminho no disco (é o
    // que um render feito no projeto deixa na part).
    for (const value of [part.src, part.path ?? ""]) {
      const key = value ? motionBundleKey(value) : null
      const hit = key ? byKey.get(key) : null
      if (hit) return hit
    }
  }
  return null
}

export interface MotionBundlePlan {
  /** Partes que não desenham nada: viraram o card ou já estão nele. */
  hidden: Set<string>
  /** Parte que dá lugar ao card → peça. */
  cards: Map<string, MotionBundle>
}

export const NO_PLAN: MotionBundlePlan = { hidden: new Set(), cards: new Map() }

/**
 * Uma mensagem, uma peça, UM card — o da mensagem onde a peça apareceu pela
 * primeira vez. As mídias dela nas mensagens seguintes somem: a peça é a mesma,
 * e o card já está na conversa mais acima, atualizado (é ele que mostra o
 * arquivo novo). Sem isto, regravar uma narração deixaria um card novo a cada
 * tentativa, que é justamente o que o card veio acabar.
 */
export function planMotionBundles(
  parts: MessagePart[],
  indexes: MotionBundleIndexes,
  messageId: string,
): MotionBundlePlan {
  if (!indexes.byKey.size) return NO_PLAN
  const hidden = new Set<string>()
  const cards = new Map<string, MotionBundle>()
  // `cards` é indexado pela PARTE, então a peça que já ganhou o card precisa de
  // um conjunto próprio — senão as duas primeiras mídias da mesma peça viram
  // dois cards.
  const claimed = new Set<string>()
  for (const part of parts) {
    const bundle = bundleOfPart(part, indexes.byKey)
    if (!bundle) continue
    // Peça ainda sem endereço (a lista acabou de chegar, o cálculo da âncora
    // vem no efeito seguinte): NADA é recolhido. Esconder a mídia para
    // reapresentá-la como card um quadro depois seria um piscar na tela.
    const anchor = indexes.anchors[bundle.motionId]
    if (!anchor) continue
    if (anchor === messageId && !claimed.has(bundle.motionId)) {
      claimed.add(bundle.motionId)
      cards.set(part.id, bundle)
      continue
    }
    hidden.add(part.id)
  }
  return hidden.size || cards.size ? { hidden, cards } : NO_PLAN
}

/**
 * Onde o card de cada peça mora: a PRIMEIRA mensagem da conversa que tem mídia
 * dela. É o que mantém "um card por peça" mesmo com mídia chegando em turnos
 * diferentes — o card original é que fica com a peça.
 */
export function motionBundleAnchors(
  messages: ChatMessage[],
  byKey: Map<string, MotionBundle>,
): Record<string, string> {
  const anchors: Record<string, string> = {}
  if (!byKey.size) return anchors
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      const bundle = bundleOfPart(part, byKey)
      if (bundle && !anchors[bundle.motionId]) anchors[bundle.motionId] = message.id
    }
  }
  return anchors
}
