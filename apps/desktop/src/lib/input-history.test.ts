import { describe, expect, it } from "vitest"
import type { ChatMessage, MessagePart, MessageReplyQuote } from "@shared/chat"
import {
  historyKeyInput,
  historyStep,
  inputHistory,
  NO_HISTORY,
  type HistoryEntry,
  type HistoryCursor,
} from "@/src/lib/input-history"

function message(role: ChatMessage["role"], ...texts: string[]): ChatMessage {
  const parts: MessagePart[] = texts.map((text, i) => ({ id: `p${i}`, type: "text", text, state: "done" }))
  return { id: `m${Math.random()}`, role, parts, createdAt: 0 }
}

/** Texto extraído de anexo: aparece para o modelo, não para a pessoa. */
function attachmentText(text: string): MessagePart {
  return { id: "pa", type: "text", text, state: "done", source: "attachment" }
}

const quote: MessageReplyQuote = { role: "assistant", text: "pergunta anterior" }

function cursor(patch: Partial<HistoryCursor> = {}): HistoryCursor {
  return { ...NO_HISTORY, ...patch }
}

describe("inputHistory", () => {
  it("traz só o que a pessoa enviou, do mais recente para o mais antigo", () => {
    const history = inputHistory([
      message("user", "primeira"),
      message("assistant", "resposta"),
      message("user", "segunda"),
      message("assistant", "outra resposta"),
    ])
    expect(history.map((e) => e.text)).toEqual(["segunda", "primeira"])
  })

  it("separa a citação do corpo — o marcador não volta para o campo", () => {
    const history = inputHistory([
      message("user", "> [assistant] pergunta anterior\n\no que eu perguntei"),
    ])
    expect(history).toEqual([{ text: "o que eu perguntei", reply: quote }])
  })

  it("ignora mensagem sem texto (só anexo) e o texto extraído de anexo", () => {
    const history = inputHistory([
      message("user", "texto de verdade"),
      { id: "m1", role: "user", parts: [attachmentText("conteúdo do PDF")], createdAt: 0 },
    ])
    expect(history.map((e) => e.text)).toEqual(["texto de verdade"])
  })

  it("não repete o mesmo texto em sequência", () => {
    const history = inputHistory([
      message("user", "de novo"),
      message("user", "de novo"),
      message("user", "antes"),
    ])
    // Do mais recente para o mais antigo: "antes" veio por último.
    expect(history.map((e) => e.text)).toEqual(["antes", "de novo"])
  })

  it("sessão vazia não tem histórico", () => {
    expect(inputHistory(undefined)).toEqual([])
    expect(inputHistory([])).toEqual([])
  })
})

describe("historyStep", () => {
  const history: HistoryEntry[] = [
    { text: "mais recente", reply: null },
    { text: "anterior", reply: null },
    { text: "mais antiga", reply: null },
  ]

  it("↑ na primeira posição recupera a mais recente e guarda o que estava digitado", () => {
    const step = historyStep(history, NO_HISTORY, { text: "", atStart: true, atEnd: true }, "older", null)
    expect(step?.entry.text).toBe("mais recente")
    expect(step?.cursor).toMatchObject({ index: 0, draft: "" })
  })

  it("↑ de novo, com o caret na primeira posição, desce no histórico", () => {
    const step = historyStep(
      history,
      cursor({ index: 0 }),
      { text: "mais recente", atStart: true, atEnd: false },
      "older",
      null,
    )
    expect(step?.entry.text).toBe("anterior")
    expect(step?.cursor.index).toBe(1)
  })

  it("↑ no topo da lista não faz nada — a seta volta a ser do caret", () => {
    expect(
      historyStep(history, cursor({ index: 2 }), { text: "mais antiga", atStart: true, atEnd: false }, "older", null),
    ).toBeNull()
  })

  it("↑ no meio de um texto de várias linhas é do caret", () => {
    expect(
      historyStep(history, NO_HISTORY, { text: "linha 1\nlinha 2", atStart: false, atEnd: false }, "older", null),
    ).toBeNull()
    // E também não escapa da regra já navegando: no meio, a seta sobe a linha.
    expect(
      historyStep(history, cursor({ index: 0 }), { text: "linha 1\nlinha 2", atStart: false, atEnd: false }, "older", null),
    ).toBeNull()
  })

  it("↓ no meio do texto é do caret, mesmo navegando", () => {
    expect(
      historyStep(history, cursor({ index: 1 }), { text: "linha 1\nlinha 2", atStart: false, atEnd: false }, "newer", null),
    ).toBeNull()
  })

  it("↓ na última posição volta pelo histórico", () => {
    const step = historyStep(
      history,
      cursor({ index: 1 }),
      { text: "anterior", atStart: false, atEnd: true },
      "newer",
      null,
    )
    expect(step?.entry.text).toBe("mais recente")
    expect(step?.cursor.index).toBe(0)
  })

  it("↓ passando da mais recente devolve o rascunho e a citação", () => {
    const comCitacao = cursor({ index: 0, draft: "digitando", reply: quote })
    const step = historyStep(history, comCitacao, { text: "mais recente", atStart: false, atEnd: true }, "newer", null)
    expect(step?.entry).toEqual({ text: "digitando", reply: quote })
    expect(step?.cursor.index).toBeNull()
  })

  it("↓ fora da navegação não mexe em nada", () => {
    expect(
      historyStep(history, NO_HISTORY, { text: "digitando", atStart: false, atEnd: true }, "newer", null),
    ).toBeNull()
  })

  it("a resposta armada entra no rascunho quando a navegação começa", () => {
    const step = historyStep(history, NO_HISTORY, { text: "respondendo", atStart: true, atEnd: false }, "older", quote)
    expect(step?.cursor.reply).toEqual(quote)
  })

  it("texto editado não reinicia a navegação: ↑ segue para a mais antiga", () => {
    const step = historyStep(
      history,
      cursor({ index: 0 }),
      { text: "mais recente editada", atStart: true, atEnd: false },
      "older",
      null,
    )
    expect(step?.entry.text).toBe("anterior")
  })

  it("sem histórico, nenhuma seta é capturada", () => {
    expect(historyStep([], NO_HISTORY, { text: "", atStart: true, atEnd: true }, "older", null)).toBeNull()
  })
})

describe("historyKeyInput", () => {
  const duasLinhas = "linha 1\nlinha 2"

  it("duas linhas: ↑ só é histórico com o caret na PRIMEIRA posição", () => {
    expect(historyKeyInput({ value: duasLinhas, selectionStart: 0, selectionEnd: 0 })?.atStart).toBe(true)
    // Caret no último caractere da linha de baixo: a seta é do caret.
    expect(historyKeyInput({ value: duasLinhas, selectionStart: 14, selectionEnd: 14 })).toEqual({
      text: duasLinhas,
      atStart: false,
      atEnd: false,
    })
  })

  it("texto SEM quebra que apenas quebrou na tela também exige a ponta", () => {
    // Regressão: a exceção de "uma linha só" fazia ↑ trocar de mensagem no meio
    // de um texto comprido que só ocupa duas linhas VISUAIS.
    const quebrado = "um texto comprido que ocupa duas linhas na tela"
    expect(historyKeyInput({ value: quebrado, selectionStart: 10, selectionEnd: 10 })).toEqual({
      text: quebrado,
      atStart: false,
      atEnd: false,
    })
  })

  it("↓ só é histórico na última posição", () => {
    expect(historyKeyInput({ value: duasLinhas, selectionStart: duasLinhas.length, selectionEnd: duasLinhas.length })?.atEnd).toBe(true)
  })

  it("campo vazio é ponta das duas", () => {
    expect(historyKeyInput({ value: "", selectionStart: 0, selectionEnd: 0 })).toEqual({
      text: "",
      atStart: true,
      atEnd: true,
    })
  })

  it("com trecho selecionado a seta não é do histórico", () => {
    expect(historyKeyInput({ value: duasLinhas, selectionStart: 2, selectionEnd: 9 })).toBeNull()
  })

  it("o texto vem do campo, não do estado do React", () => {
    const step = historyStep(
      [{ text: "anterior", reply: null }],
      NO_HISTORY,
      historyKeyInput({ value: duasLinhas, selectionStart: 0, selectionEnd: 0 })!,
      "older",
      null,
    )
    expect(step?.cursor.draft).toBe(duasLinhas)
  })
})
