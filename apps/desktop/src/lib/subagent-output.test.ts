import { describe, expect, it } from "vitest"
import { SUBAGENT_EMPTY_OUTPUT, SUBAGENT_NO_FOLDER_NOTICE, parseSubagentOutput } from "@shared/chat"

describe("parseSubagentOutput", () => {
  it("resposta comum passa como está", () => {
    expect(parseSubagentOutput("Achei 3 arquivos.")).toEqual({ noFolder: false, empty: false, text: "Achei 3 arquivos." })
  })

  it("separa o aviso de sem pasta do texto do subagente", () => {
    const out = parseSubagentOutput(`${SUBAGENT_NO_FOLDER_NOTICE}\n\nResposta do subagente`)
    expect(out).toEqual({ noFolder: true, empty: false, text: "Resposta do subagente" })
  })

  it("resultado vazio vira a marca empty, sem texto para o modelo na UI", () => {
    expect(parseSubagentOutput(SUBAGENT_EMPTY_OUTPUT)).toEqual({ noFolder: false, empty: true, text: "" })
    expect(parseSubagentOutput(`${SUBAGENT_NO_FOLDER_NOTICE}\n\n${SUBAGENT_EMPTY_OUTPUT}`)).toEqual({
      noFolder: true,
      empty: true,
      text: "",
    })
  })

  it("conversas antigas em português continuam reconhecidas", () => {
    const antigo =
      "[Aviso: não há pasta de trabalho nesta conversa — o subagente rodou em modo chat, sem acesso a arquivos.]\n\n(o subagente não retornou texto)"
    expect(parseSubagentOutput(antigo)).toEqual({ noFolder: true, empty: true, text: "" })
  })
})
