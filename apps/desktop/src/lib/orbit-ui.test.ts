import { describe, expect, it } from "vitest"

import { parseOrbitUi } from "./orbit-ui"

const stats = '{"type":"stats","items":[{"label":"MRR","value":1200}]}'
const callout = '{"type":"callout","text":"Atenção"}'

describe("parseOrbitUi", () => {
  it("lê um componente por linha e normaliza números para texto", () => {
    const { blocks, pending } = parseOrbitUi(`${stats}\n${callout}`, false)
    expect(pending).toBe(false)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: "stats", items: [{ value: "1200" }] })
    expect(blocks[1]).toMatchObject({ type: "callout", tone: "info" })
  })

  it("desenha a linha pronta enquanto a seguinte ainda chega", () => {
    const partial = `${stats}\n{"type":"callout","te`
    const { blocks, pending } = parseOrbitUi(partial, true)
    expect(blocks).toHaveLength(1)
    expect(pending).toBe(true)
  })

  it("não marca pendente quando a última linha já fechou", () => {
    expect(parseOrbitUi(stats, true).pending).toBe(false)
  })

  it("descarta linha inválida em vez de quebrar a resposta", () => {
    const { blocks, pending } = parseOrbitUi(`{"type":"nope"}\n${callout}\nlixo`, false)
    expect(blocks).toHaveLength(1)
    expect(pending).toBe(false)
  })

  it("rejeita componente fora do limite do catálogo", () => {
    const compare = '{"type":"compare","items":[{"title":"A","points":["x"]}]}'
    expect(parseOrbitUi(compare, false).blocks).toHaveLength(0)
  })
})

describe("blocos interativos", () => {
  it("lê inputs, normaliza opções e aplica os padrões", () => {
    const { blocks } = parseOrbitUi(
      [
        '{"type":"slider","id":"juros","label":"Juros","min":0,"max":20}',
        '{"type":"select","id":"plano","options":["Free",{"label":"Pro","value":29}]}',
        '{"type":"tabs","id":"v","options":["A","B"],"showIf":"juros>1"}',
      ].join("\n"),
      false,
    )
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toMatchObject({ options: [{ label: "Free", value: "Free" }, { label: "Pro", value: 29 }] })
    expect(blocks[2]).toMatchObject({ showIf: "juros>1" })
  })

  it("rejeita id que não é um nome de variável", () => {
    expect(parseOrbitUi('{"type":"toggle","id":"a b","label":"x"}', false).blocks).toHaveLength(0)
    expect(parseOrbitUi('{"type":"toggle","id":"1a","label":"x"}', false).blocks).toHaveLength(0)
  })

  it("gráfico exige pontos ou funções com x", () => {
    expect(parseOrbitUi('{"type":"chart","kind":"line"}', false).blocks).toHaveLength(0)
    expect(parseOrbitUi('{"type":"chart","fns":[{"fn":"x"}]}', false).blocks).toHaveLength(0)
    expect(parseOrbitUi('{"type":"chart","fns":[{"fn":"2*x"}],"x":[0,10]}', false).blocks).toHaveLength(1)
    expect(parseOrbitUi('{"type":"chart","data":[{"label":"a","value":"k*2"}]}', false).blocks).toHaveLength(1)
  })

  it("botões aceitam as três ações", () => {
    const line = '{"type":"buttons","items":[{"label":"a","action":"send","text":"oi"},{"label":"b","action":"set","id":"v","value":"B"}]}'
    expect(parseOrbitUi(line, false).blocks).toHaveLength(1)
    expect(parseOrbitUi('{"type":"buttons","items":[{"label":"a","action":"eval"}]}', false).blocks).toHaveLength(0)
  })
})
