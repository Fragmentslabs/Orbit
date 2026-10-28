import { describe, expect, it } from "vitest"
import type { ChatMessage, MessagePart } from "@shared/chat"
import type { MotionBundle } from "@shared/media"
import {
  bundleOfPart,
  indexMotionBundles,
  motionBundleAnchors,
  planMotionBundles,
} from "./motion-bundle"

/**
 * O recolhimento das mídias de uma peça em UM card.
 *
 * A regra que estes testes protegem: a peça tem um card só, na mensagem onde ela
 * apareceu, e ele mostra os arquivos ATUAIS — as mídias das mensagens seguintes
 * somem em vez de virarem cards novos. É o que faz "regravar a narração" ser uma
 * atualização, e não mais uma bolha na conversa.
 */

function bundle(id: string, keys: string[]): MotionBundle {
  return {
    motionId: id,
    name: id,
    folder: `/peças/${id}`,
    files: [],
    totalBytes: 0,
    discarded: 0,
    keys,
  }
}

const audio = (id: string, src: string): MessagePart => ({
  id,
  type: "audio",
  src,
  title: "narração",
} as MessagePart)

const image = (id: string, src: string): MessagePart =>
  ({ id, type: "image", src, alt: "" }) as MessagePart

const text = (id: string, value: string): MessagePart => ({
  id,
  type: "text",
  text: value,
  state: "done",
})

const INTRO = bundle("mv_intro", ["aud_narracao.wav", "img_capa.png"])
const OUTRA = bundle("mv_outra", ["aud_outra.wav"])

describe("bundleOfPart", () => {
  const { byKey } = indexMotionBundles([INTRO, OUTRA], {})

  it("reconhece a mídia pela URL do registro", () => {
    expect(bundleOfPart(audio("p1", "orbit-audio://aud_narracao.wav"), byKey)?.motionId).toBe("mv_intro")
    expect(bundleOfPart(image("p2", "orbit-media://img_capa.png"), byKey)?.motionId).toBe("mv_intro")
    expect(bundleOfPart(audio("p3", "orbit-audio://aud_outra.wav"), byKey)?.motionId).toBe("mv_outra")
  })

  it("mídia que não é de peça nenhuma continua um player solto", () => {
    expect(bundleOfPart(audio("p4", "orbit-audio://aud_avulsa.wav"), byKey)).toBeNull()
    expect(bundleOfPart(text("p5", "oi"), byKey)).toBeNull()
  })

  it("vídeo é reconhecido pela URL ou pelo caminho no disco", () => {
    const comPath = bundle("mv_video", ["/tmp/projeto/clipe.mp4"])
    const indexes = indexMotionBundles([comPath], {})
    const part = { id: "p6", type: "video", src: "orbit-video://vid_x", path: "/tmp/projeto/clipe.mp4" } as MessagePart
    expect(bundleOfPart(part, indexes.byKey)?.motionId).toBe("mv_video")
  })

  it("sem peças carregadas, nada é recolhido", () => {
    expect(bundleOfPart(audio("p7", "orbit-audio://aud_narracao.wav"), new Map())).toBeNull()
  })
})

describe("planMotionBundles", () => {
  it("sem endereço ainda, não recolhe nada (a lista chegou, a âncora não)", () => {
    const indexes = indexMotionBundles([INTRO], {})
    const plan = planMotionBundles([audio("p1", "orbit-audio://aud_narracao.wav")], indexes, "m1")
    expect(plan.cards.size).toBe(0)
    expect(plan.hidden.size).toBe(0)
  })


  const messages: ChatMessage[] = [
    { id: "m1", role: "user", parts: [text("u1", "faz uma peça")] } as ChatMessage,
    {
      id: "m2",
      role: "assistant",
      parts: [text("t1", "vou montar"), audio("a1", "orbit-audio://aud_narracao.wav"), text("t2", "pronto")],
    } as ChatMessage,
    {
      id: "m3",
      role: "assistant",
      parts: [text("t3", "troquei a narração"), audio("a2", "orbit-audio://aud_narracao.wav")],
    } as ChatMessage,
  ]
  const { byKey } = indexMotionBundles([INTRO, OUTRA], {})
  const anchors = motionBundleAnchors(messages, byKey)

  it("o card mora na PRIMEIRA mensagem com mídia da peça", () => {
    expect(anchors).toEqual({ mv_intro: "m2" })
  })

  it("na mensagem do card, a primeira mídia vira o card e as outras somem", () => {
    const parts = [image("i1", "orbit-media://img_capa.png"), audio("a1", "orbit-audio://aud_narracao.wav")]
    const plan = planMotionBundles(parts, { byKey, anchors }, "m2")
    // A primeira da peça dá lugar ao card; a segunda é uma linha dele.
    expect([...plan.cards.keys()]).toEqual(["i1"])
    expect(plan.cards.get("i1")?.motionId).toBe("mv_intro")
    expect([...plan.hidden]).toEqual(["a1"])
  })

  it("mídia repetida numa mensagem seguinte é recolhida, sem card novo", () => {
    const plan = planMotionBundles(messages[2].parts, { byKey, anchors }, "m3")
    expect(plan.cards.size).toBe(0)
    expect([...plan.hidden]).toEqual(["a2"])
  })

  it("duas peças na mesma mensagem: um card para cada", () => {
    const plano = indexMotionBundles([INTRO, OUTRA], { mv_intro: "m9", mv_outra: "m9" })
    const parts = [audio("a8", "orbit-audio://aud_narracao.wav"), audio("a9", "orbit-audio://aud_outra.wav")]
    const plan = planMotionBundles(parts, plano, "m9")
    expect(plan.cards.size).toBe(2)
    expect(plan.hidden.size).toBe(0)
  })

  it("sem âncora (peça ainda não carregada), nada muda na conversa", () => {
    const plan = planMotionBundles(messages[1].parts, { byKey, anchors: {} }, "m2")
    expect(plan.cards.size).toBe(0)
    // Nem card nem sumiço: a mídia continua sendo o player dela até o endereço
    // do card ser calculado (senão a conversa piscaria a cada carga).
    expect(plan.hidden.size).toBe(0)
  })
})

describe("motionBundleAnchors", () => {
  it("a primeira mensagem manda, mesmo quando a mídia volta depois", () => {
    const first = {
      id: "m1",
      role: "assistant",
      parts: [audio("a1", "orbit-audio://aud_narracao.wav")],
    } as ChatMessage
    const second = {
      id: "m2",
      role: "assistant",
      parts: [audio("a2", "orbit-audio://aud_narracao.wav")],
    } as ChatMessage
    const { byKey } = indexMotionBundles([INTRO], {})
    expect(motionBundleAnchors([first, second], byKey)).toEqual({ mv_intro: "m1" })
  })

  it("mensagem do usuário não ancora card", () => {
    const msg = {
      id: "m1",
      role: "user",
      parts: [audio("a1", "orbit-audio://aud_narracao.wav")],
    } as ChatMessage
    const { byKey } = indexMotionBundles([INTRO], {})
    expect(motionBundleAnchors([msg], byKey)).toEqual({})
  })
})
