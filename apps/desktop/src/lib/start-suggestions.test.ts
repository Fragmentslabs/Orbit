import { describe, expect, it } from "vitest"
import type { MediaKind } from "@shared/media"

import { buildStartSuggestions, MAX_SUGGESTIONS, type StartContext, type Translate } from "@/src/lib/start-suggestions"

/**
 * The start screen suggestions are the first thing the person sees and the only
 * place where hidden capabilities (motion, audio, photo editing) show up
 * without them looking for it. What these tests lock down: never promise what cannot
 * be done, fill in instead of sending, and do not repeat the same capability.
 */

const t: Translate = (key, options) => (options?.title ? `${key}:${String(options.title)}` : key)

const base: StartContext = { mode: "chat", day: "2026-10-21" }

const ids = (ctx: StartContext) => buildStartSuggestions(ctx, t).map((suggestion) => suggestion.id)

describe("buildStartSuggestions", () => {
  it("suggests nothing in code mode with no working folder", () => {
    expect(buildStartSuggestions({ ...base, mode: "code" }, t)).toEqual([])
  })

  it("returns suggestions in code mode when there is a folder", () => {
    expect(buildStartSuggestions({ ...base, mode: "code", directory: "/ws/app" }, t).length).toBeGreaterThan(0)
  })

  it("fills the composer instead of sending the message", () => {
    const suggestions = buildStartSuggestions(base, t)
    for (const suggestion of suggestions) {
      expect(suggestion.action.kind).toBe("fill")
    }
  })

  it("puts the previous session first, as navigation", () => {
    const [first, ...rest] = buildStartSuggestions(
      { ...base, lastSession: { id: "s1", title: "Planejamento da viagem", mode: "chat" } },
      t,
    )
    expect(first.action).toEqual({ kind: "open", sessionId: "s1", mode: "chat" })
    expect(first.label).toBe("chat.start.resume:Planejamento da viagem")
    expect(rest.every((suggestion) => suggestion.action.kind === "fill")).toBe(true)
  })

  it(`never goes past ${MAX_SUGGESTIONS} suggestions, with or without a previous session`, () => {
    expect(buildStartSuggestions(base, t).length).toBeLessThanOrEqual(MAX_SUGGESTIONS)
    expect(
      buildStartSuggestions({ ...base, lastSession: { id: "s1", title: "Ontem", mode: "chat" } }, t).length,
    ).toBeLessThanOrEqual(MAX_SUGGESTIONS)
  })

  it("does not repeat the same capability", () => {
    const suggestions = buildStartSuggestions(base, t)
    expect(new Set(suggestions.map((suggestion) => suggestion.id)).size).toBe(suggestions.length)
  })

  it("is deterministic on the same day and in the same mode", () => {
    expect(ids(base)).toEqual(ids(base))
  })

  it("changes the selection from one day to the next", () => {
    const days = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]
    const assinaturas = new Set(days.map((day) => ids({ ...base, day: `2026-10-${day}` }).join("|")))
    expect(assinaturas.size).toBeGreaterThan(1)
  })

  it("prioritizes the family the person never produced", () => {
    // Already made image, artifact, document, motion and audio — never made video.
    const usedKinds: MediaKind[] = ["image", "artifact", "document", "motion", "audio"]
    const suggestions = buildStartSuggestions({ ...base, usedKinds }, t)
    // Two capabilities produce video: editing one that already exists and recording a
    // new one. Either of the two serves the invitation.
    expect(
      suggestions.some(
        (suggestion) => suggestion.capability === "video" || suggestion.capability === "record",
      ),
    ).toBe(true)
  })

  it("offers neither generated audio nor transcription with voice off", () => {
    // Off, the tool is not even registered in the turn — the pill would be a promise
    // the agent cannot keep. Thirty days cover the rotations.
    for (let day = 1; day <= 30; day++) {
      const suggestions = buildStartSuggestions(
        {
          ...base,
          day: `2026-11-${String(day).padStart(2, "0")}`,
          features: { tts: false, stt: false, browser: true },
        },
        t,
      )
      const promised = suggestions.some(
        (suggestion) => suggestion.capability === "audio" || suggestion.capability === "transcript",
      )
      expect(promised, `dia ${day}`).toBe(false)
    }
  })

  it("does not promise video recording without the browser tools", () => {
    for (let day = 1; day <= 30; day++) {
      const suggestions = buildStartSuggestions(
        {
          ...base,
          day: `2026-12-${String(day).padStart(2, "0")}`,
          features: { tts: true, stt: true, browser: false },
        },
        t,
      )
      expect(suggestions.some((suggestion) => suggestion.capability === "record"), `dia ${day}`).toBe(false)
    }
  })

  it("offers audio and transcription again with both halves on", () => {
    const seen = new Set<string>()
    for (let day = 1; day <= 30; day++) {
      const suggestions = buildStartSuggestions(
        {
          ...base,
          day: `2026-11-${String(day).padStart(2, "0")}`,
          features: { tts: true, stt: true, browser: true },
        },
        t,
      )
      for (const suggestion of suggestions) {
        if (suggestion.capability) seen.add(suggestion.capability)
      }
    }
    expect(seen.has("audio")).toBe(true)
    expect(seen.has("transcript")).toBe(true)
  })

  it("even with every family already used, it still suggests three", () => {
    const usedKinds: MediaKind[] = ["image", "artifact", "document", "motion", "audio", "video"]
    const suggestions = buildStartSuggestions({ ...base, usedKinds }, t)
    expect(suggestions).toHaveLength(MAX_SUGGESTIONS)
    expect(suggestions.every((suggestion) => !suggestion.fresh)).toBe(true)
  })
})
