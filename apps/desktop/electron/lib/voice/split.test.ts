import { describe, expect, it } from "vitest"
import { splitForStreaming } from "../../voice-engine/split.mjs"

describe("splitForStreaming", () => {
  it("joins short sentences up to the target", () => {
    expect(splitForStreaming("Claro. Aqui está.", 140)).toEqual(["Claro. Aqui está."])
  })

  it("splits sentences when the sum passes the target", () => {
    expect(splitForStreaming("Claro. Aqui está o resumo.", 20)).toEqual(["Claro.", "Aqui está o resumo."])
  })

  it("a long sentence is split at the natural pauses", () => {
    const text = "Posso escrever textos, mexer no código dos seus projetos, ler documentos e montar designs."
    expect(splitForStreaming(text, 40)).toEqual([
      "Posso escrever textos,",
      "mexer no código dos seus projetos,",
      "ler documentos e montar designs.",
    ])
  })

  it("with no natural pause, the long sentence stays whole", () => {
    const text = "Uma frase muito longa sem nenhuma pausa natural que caiba no alvo pedido pelo motor."
    expect(splitForStreaming(text, 20)).toEqual([text])
  })

  it("a short pause does not split a sentence that already fits the target", () => {
    const text = "Posso escrever textos, mexer no código e montar designs."
    expect(splitForStreaming(text, 140)).toEqual([text])
  })

  it("empty text does not become a chunk", () => {
    expect(splitForStreaming("  \n ", 140)).toEqual([])
  })
})
