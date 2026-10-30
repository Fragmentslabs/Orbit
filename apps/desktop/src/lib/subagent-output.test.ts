import { describe, expect, it } from "vitest"
import { SUBAGENT_EMPTY_OUTPUT, SUBAGENT_NO_FOLDER_NOTICE, parseSubagentOutput } from "@shared/chat"

describe("parseSubagentOutput", () => {
  it("an ordinary reply passes as it is", () => {
    expect(parseSubagentOutput("Achei 3 arquivos.")).toEqual({ noFolder: false, empty: false, text: "Achei 3 arquivos." })
  })

  it("separates the no-folder notice from the subagent's text", () => {
    const out = parseSubagentOutput(`${SUBAGENT_NO_FOLDER_NOTICE}\n\nResposta do subagente`)
    expect(out).toEqual({ noFolder: true, empty: false, text: "Resposta do subagente" })
  })

  it("an empty result becomes the empty mark, with no text for the model in the UI", () => {
    expect(parseSubagentOutput(SUBAGENT_EMPTY_OUTPUT)).toEqual({ noFolder: false, empty: true, text: "" })
    expect(parseSubagentOutput(`${SUBAGENT_NO_FOLDER_NOTICE}\n\n${SUBAGENT_EMPTY_OUTPUT}`)).toEqual({
      noFolder: true,
      empty: true,
      text: "",
    })
  })

  it("old Portuguese conversations are still recognized", () => {
    const legacy =
      "[Aviso: não há pasta de trabalho nesta conversa — o subagente rodou em modo chat, sem acesso a arquivos.]\n\n(o subagente não retornou texto)"
    expect(parseSubagentOutput(legacy)).toEqual({ noFolder: true, empty: true, text: "" })
  })
})
