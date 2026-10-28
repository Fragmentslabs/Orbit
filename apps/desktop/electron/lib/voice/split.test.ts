import { describe, expect, it } from "vitest"
import { splitForStreaming } from "../../voice-engine/split.mjs"

describe("splitForStreaming", () => {
  it("junta frases curtas até o alvo", () => {
    expect(splitForStreaming("Claro. Aqui está.", 140)).toEqual(["Claro. Aqui está."])
  })

  it("separa frases quando a soma passa do alvo", () => {
    expect(splitForStreaming("Claro. Aqui está o resumo.", 20)).toEqual(["Claro.", "Aqui está o resumo."])
  })

  it("uma frase longa é dividida nas pausas naturais", () => {
    const text = "Posso escrever textos, mexer no código dos seus projetos, ler documentos e montar designs."
    expect(splitForStreaming(text, 40)).toEqual([
      "Posso escrever textos,",
      "mexer no código dos seus projetos,",
      "ler documentos e montar designs.",
    ])
  })

  it("sem pausa natural, a frase longa fica inteira", () => {
    const text = "Uma frase muito longa sem nenhuma pausa natural que caiba no alvo pedido pelo motor."
    expect(splitForStreaming(text, 20)).toEqual([text])
  })

  it("uma pausa curta não separa uma frase que já cabe no alvo", () => {
    const text = "Posso escrever textos, mexer no código e montar designs."
    expect(splitForStreaming(text, 140)).toEqual([text])
  })

  it("texto vazio não vira pedaço", () => {
    expect(splitForStreaming("  \n ", 140)).toEqual([])
  })
})
