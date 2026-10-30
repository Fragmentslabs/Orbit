import { describe, expect, it } from "vitest"

import { parseOrbitUi } from "./orbit-ui"

const stats = '{"type":"stats","items":[{"label":"MRR","value":1200}]}'
const callout = '{"type":"callout","text":"Atenção"}'

describe("parseOrbitUi", () => {
  it("reads one component per line and normalizes numbers to text", () => {
    const { blocks, pending } = parseOrbitUi(`${stats}\n${callout}`, false)
    expect(pending).toBe(false)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: "stats", items: [{ value: "1200" }] })
    expect(blocks[1]).toMatchObject({ type: "callout", tone: "info" })
  })

  it("draws the finished line while the next one still arrives", () => {
    const partial = `${stats}\n{"type":"callout","te`
    const { blocks, pending } = parseOrbitUi(partial, true)
    expect(blocks).toHaveLength(1)
    expect(pending).toBe(true)
  })

  it("does not mark pending when the last line already closed", () => {
    expect(parseOrbitUi(stats, true).pending).toBe(false)
  })

  it("discards an invalid line instead of breaking the reply", () => {
    const { blocks, pending } = parseOrbitUi(`{"type":"nope"}\n${callout}\nlixo`, false)
    expect(blocks).toHaveLength(1)
    expect(pending).toBe(false)
  })

  it("rejects a component outside the catalog limit", () => {
    const compare = '{"type":"compare","items":[{"title":"A","points":["x"]}]}'
    expect(parseOrbitUi(compare, false).blocks).toHaveLength(0)
  })
})

describe("blocos interativos", () => {
  it("reads inputs, normalizes options and applies the defaults", () => {
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

  it("rejects an id that is not a variable name", () => {
    expect(parseOrbitUi('{"type":"toggle","id":"a b","label":"x"}', false).blocks).toHaveLength(0)
    expect(parseOrbitUi('{"type":"toggle","id":"1a","label":"x"}', false).blocks).toHaveLength(0)
  })

  it("a chart requires points or functions with x", () => {
    expect(parseOrbitUi('{"type":"chart","kind":"line"}', false).blocks).toHaveLength(0)
    expect(parseOrbitUi('{"type":"chart","fns":[{"fn":"x"}]}', false).blocks).toHaveLength(0)
    expect(parseOrbitUi('{"type":"chart","fns":[{"fn":"2*x"}],"x":[0,10]}', false).blocks).toHaveLength(1)
    expect(parseOrbitUi('{"type":"chart","data":[{"label":"a","value":"k*2"}]}', false).blocks).toHaveLength(1)
  })

  it("buttons accept the three actions", () => {
    const line = '{"type":"buttons","items":[{"label":"a","action":"send","text":"oi"},{"label":"b","action":"set","id":"v","value":"B"}]}'
    expect(parseOrbitUi(line, false).blocks).toHaveLength(1)
    expect(parseOrbitUi('{"type":"buttons","items":[{"label":"a","action":"eval"}]}', false).blocks).toHaveLength(0)
  })
})

describe("navigation card", () => {
  it("reads the destination and the note", () => {
    const line = '{"type":"nav","destination":"voice","note":"Leitura em voz alta"}'
    const { blocks } = parseOrbitUi(line, false)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: "nav", destination: "voice", note: "Leitura em voz alta" })
  })

  it("still reads a card written with the legacy field names", () => {
    const { blocks } = parseOrbitUi('{"type":"nav","destino":"voice","nota":"Leitura em voz alta"}', false)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: "nav", destination: "voice", note: "Leitura em voz alta" })
  })

  it("does not validate the destination here: the screen is what resolves it", () => {
    // An invented id has to reach the renderer so that it decides not to draw
    // anything — discarding it in the parse would hide the model's error.
    const { blocks } = parseOrbitUi('{"type":"nav","destination":"nao-existe"}', false)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ destination: "nao-existe" })
  })
})
