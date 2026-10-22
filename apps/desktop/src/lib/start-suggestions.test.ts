import { describe, expect, it } from "vitest"
import type { MediaKind } from "@shared/media"

import { buildStartSuggestions, MAX_SUGGESTIONS, type StartContext, type Translate } from "@/src/lib/start-suggestions"

/**
 * As sugestões da tela inicial são a primeira coisa que a pessoa vê e o único
 * lugar onde capacidades escondidas (motion, áudio, edição de foto) aparecem
 * sem ela procurar. O que estes testes travam: nunca prometer o que não dá
 * para fazer, preencher em vez de enviar, e não repetir a mesma capacidade.
 */

const t: Translate = (key, options) => (options?.title ? `${key}:${String(options.title)}` : key)

const base: StartContext = { mode: "chat", day: "2026-10-21" }

const ids = (ctx: StartContext) => buildStartSuggestions(ctx, t).map((suggestion) => suggestion.id)

describe("buildStartSuggestions", () => {
  it("não sugere nada no modo código sem pasta de trabalho", () => {
    expect(buildStartSuggestions({ ...base, mode: "code" }, t)).toEqual([])
  })

  it("devolve sugestões no modo código quando há pasta", () => {
    expect(buildStartSuggestions({ ...base, mode: "code", directory: "/ws/app" }, t).length).toBeGreaterThan(0)
  })

  it("preenche o composer em vez de enviar a mensagem", () => {
    const suggestions = buildStartSuggestions(base, t)
    for (const suggestion of suggestions) {
      expect(suggestion.action.kind).toBe("fill")
    }
  })

  it("põe a sessão anterior em primeiro, como navegação", () => {
    const [first, ...rest] = buildStartSuggestions(
      { ...base, lastSession: { id: "s1", title: "Planejamento da viagem", mode: "chat" } },
      t,
    )
    expect(first.action).toEqual({ kind: "open", sessionId: "s1", mode: "chat" })
    expect(first.label).toBe("chat.start.resume:Planejamento da viagem")
    expect(rest.every((suggestion) => suggestion.action.kind === "fill")).toBe(true)
  })

  it(`não passa de ${MAX_SUGGESTIONS} sugestões, com ou sem sessão anterior`, () => {
    expect(buildStartSuggestions(base, t).length).toBeLessThanOrEqual(MAX_SUGGESTIONS)
    expect(
      buildStartSuggestions({ ...base, lastSession: { id: "s1", title: "Ontem", mode: "chat" } }, t).length,
    ).toBeLessThanOrEqual(MAX_SUGGESTIONS)
  })

  it("não repete a mesma capacidade", () => {
    const suggestions = buildStartSuggestions(base, t)
    expect(new Set(suggestions.map((suggestion) => suggestion.id)).size).toBe(suggestions.length)
  })

  it("é determinístico no mesmo dia e no mesmo modo", () => {
    expect(ids(base)).toEqual(ids(base))
  })

  it("muda a seleção de um dia para o outro", () => {
    const days = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]
    const assinaturas = new Set(days.map((day) => ids({ ...base, day: `2026-10-${day}` }).join("|")))
    expect(assinaturas.size).toBeGreaterThan(1)
  })

  it("prioriza a família que a pessoa nunca produziu", () => {
    // Já fez imagem, artefato, documento, motion e áudio — nunca fez vídeo.
    const usedKinds: MediaKind[] = ["image", "artifact", "document", "motion", "audio"]
    const suggestions = buildStartSuggestions({ ...base, usedKinds }, t)
    // Duas capacidades produzem vídeo: editar um que já existe e gravar um
    // novo. Qualquer uma das duas serve ao convite.
    expect(
      suggestions.some(
        (suggestion) => suggestion.capability === "video" || suggestion.capability === "record",
      ),
    ).toBe(true)
  })

  it("não oferece áudio gerado nem transcrição com a voz desligada", () => {
    // Desligada, a tool nem é registrada no turno — a pill seria uma promessa
    // que o agente não consegue cumprir. Trinta dias cobrem as rotações.
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

  it("não promete gravação de vídeo sem as ferramentas de navegador", () => {
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

  it("volta a oferecer áudio e transcrição com as duas metades ligadas", () => {
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

  it("mesmo com todas as famílias já usadas, ainda sugere três", () => {
    const usedKinds: MediaKind[] = ["image", "artifact", "document", "motion", "audio", "video"]
    const suggestions = buildStartSuggestions({ ...base, usedKinds }, t)
    expect(suggestions).toHaveLength(MAX_SUGGESTIONS)
    expect(suggestions.every((suggestion) => !suggestion.fresh)).toBe(true)
  })
})
