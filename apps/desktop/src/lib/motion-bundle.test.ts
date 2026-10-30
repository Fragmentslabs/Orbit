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
 * The gathering of a piece's media into ONE card.
 *
 * The rule these tests protect: the piece has a single card, in the message where it
 * appeared, and it shows the CURRENT files — the media of the following messages
 * vanish instead of becoming new cards. That is what makes "re-record the narration" an
 * update, and not one more bubble in the conversation.
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
const OTHER = bundle("mv_other", ["aud_outra.wav"])

describe("bundleOfPart", () => {
  const { byKey } = indexMotionBundles([INTRO, OTHER], {})

  it("recognizes the media by the registry URL", () => {
    expect(bundleOfPart(audio("p1", "orbit-audio://aud_narracao.wav"), byKey)?.motionId).toBe("mv_intro")
    expect(bundleOfPart(image("p2", "orbit-media://img_capa.png"), byKey)?.motionId).toBe("mv_intro")
    expect(bundleOfPart(audio("p3", "orbit-audio://aud_outra.wav"), byKey)?.motionId).toBe("mv_other")
  })

  it("media that belongs to no piece stays a loose player", () => {
    expect(bundleOfPart(audio("p4", "orbit-audio://aud_avulsa.wav"), byKey)).toBeNull()
    expect(bundleOfPart(text("p5", "oi"), byKey)).toBeNull()
  })

  it("video is recognized by the URL or by the path on disk", () => {
    const comPath = bundle("mv_video", ["/tmp/projeto/clipe.mp4"])
    const indexes = indexMotionBundles([comPath], {})
    const part = { id: "p6", type: "video", src: "orbit-video://vid_x", path: "/tmp/projeto/clipe.mp4" } as MessagePart
    expect(bundleOfPart(part, indexes.byKey)?.motionId).toBe("mv_video")
  })

  it("with no pieces loaded, nothing is collapsed", () => {
    expect(bundleOfPart(audio("p7", "orbit-audio://aud_narracao.wav"), new Map())).toBeNull()
  })
})

describe("planMotionBundles", () => {
  it("with no address yet, it collapses nothing (the list arrived, the anchor did not)", () => {
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
  const { byKey } = indexMotionBundles([INTRO, OTHER], {})
  const anchors = motionBundleAnchors(messages, byKey)

  it("the card lives in the FIRST message with media of the piece", () => {
    expect(anchors).toEqual({ mv_intro: "m2" })
  })

  it("in the card's message, the first media becomes the card and the others disappear", () => {
    const parts = [image("i1", "orbit-media://img_capa.png"), audio("a1", "orbit-audio://aud_narracao.wav")]
    const plan = planMotionBundles(parts, { byKey, anchors }, "m2")
    // The first one of the piece gives way to the card; the second is a line of it.
    expect([...plan.cards.keys()]).toEqual(["i1"])
    expect(plan.cards.get("i1")?.motionId).toBe("mv_intro")
    expect([...plan.hidden]).toEqual(["a1"])
  })

  it("repeated media in a following message is collapsed, with no new card", () => {
    const plan = planMotionBundles(messages[2].parts, { byKey, anchors }, "m3")
    expect(plan.cards.size).toBe(0)
    expect([...plan.hidden]).toEqual(["a2"])
  })

  it("two pieces in the same message: one card for each", () => {
    const plano = indexMotionBundles([INTRO, OTHER], { mv_intro: "m9", mv_other: "m9" })
    const parts = [audio("a8", "orbit-audio://aud_narracao.wav"), audio("a9", "orbit-audio://aud_outra.wav")]
    const plan = planMotionBundles(parts, plano, "m9")
    expect(plan.cards.size).toBe(2)
    expect(plan.hidden.size).toBe(0)
  })

  it("with no anchor (piece not loaded yet), nothing changes in the conversation", () => {
    const plan = planMotionBundles(messages[1].parts, { byKey, anchors: {} }, "m2")
    expect(plan.cards.size).toBe(0)
    // Neither card nor vanishing: the media keeps being its own player until the card's
    // address is computed (otherwise the conversation would blink on every load).
    expect(plan.hidden.size).toBe(0)
  })
})

describe("motionBundleAnchors", () => {
  it("the first message rules, even when the media comes back later", () => {
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

  it("a user message anchors no card", () => {
    const msg = {
      id: "m1",
      role: "user",
      parts: [audio("a1", "orbit-audio://aud_narracao.wav")],
    } as ChatMessage
    const { byKey } = indexMotionBundles([INTRO], {})
    expect(motionBundleAnchors([msg], byKey)).toEqual({})
  })
})
