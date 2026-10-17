import { describe, expect, it } from "vitest"
import type { ToolPart } from "@shared/chat"
import { motionFormatInReport, motionNameInReport, motionRefOf } from "./motion-part-ref"

/** O relatório de uma peça que abriu bem (o texto real da tool, resumido). */
const OK =
  'Motion "orbit-apresentacao" is open in the Motion tab of the right panel (edit/animations/orbit-apresentacao/index.html) ' +
  "and loads fine: 1920x1080, 1140 frames at 30 fps (38.00 s).\nLayers (when each enters and leaves the frame):\n…"

/** O relatório de uma peça que abriu e NÃO carregou. */
const FAILED =
  'Motion "orbit-apresentacao" is open in the Motion tab, but it DID NOT LOAD: no orbit-motion meta. ' +
  "The user is looking at an empty stage — fix it with motion_edit."

function part(tool: string, input: Record<string, unknown>, output?: string): ToolPart {
  return { id: "p1", type: "tool", tool, state: "done", input, output }
}

describe("nome e formato no relatório", () => {
  it("lê o nome da peça entre aspas", () => {
    expect(motionNameInReport(OK)).toBe("orbit-apresentacao")
    expect(motionNameInReport(FAILED)).toBe("orbit-apresentacao")
    expect(motionNameInReport(undefined)).toBeNull()
    expect(motionNameInReport("nada aqui")).toBeNull()
  })

  it("lê o formato medido — e só quando a peça carregou", () => {
    expect(motionFormatInReport(OK)).toBe("1920×1080 · 38s")
    // Sem as medidas não há o que mostrar: o card não inventa formato.
    expect(motionFormatInReport(FAILED)).toBeNull()
  })
})

describe("a referência do card", () => {
  it("modo código: a peça é a pasta do projeto, endereçada por caminho", () => {
    const ref = motionRefOf(part("motion_preview", { path: "edit/animations/orbit-apresentacao/index.html" }, OK))
    expect(ref).toMatchObject({
      path: "edit/animations/orbit-apresentacao/index.html",
      label: "orbit-apresentacao",
      format: "1920×1080 · 38s",
    })
    // O caminho do main é o caminho que o agente deu — o card não o reescreve.
    expect(ref?.name).toBeUndefined()
  })

  it("modo chat: sem caminho, a peça é endereçada por NOME", () => {
    // motion_write({ name, html }) não tem `path` nenhum: era exatamente aqui
    // que o card devolvia null e a composição do chat ficava sem card.
    const ref = motionRefOf(part("motion_write", { name: "Intro do Orbit!", html: "<html/>" }, OK))
    expect(ref).toMatchObject({ name: "orbit-apresentacao", label: "orbit-apresentacao" })
    expect(ref?.path).toBeUndefined()
  })

  it("o nome do relatório vence o do caminho no título", () => {
    const ref = motionRefOf(part("motion_preview", { path: "some/pasta/index.html" }, OK))
    expect(ref?.label).toBe("orbit-apresentacao")
  })

  it("sem relatório, o caminho ainda nomeia o card", () => {
    const ref = motionRefOf(part("motion_preview", { path: "edit/animations/orbit-apresentacao" }))
    expect(ref).toMatchObject({ path: "edit/animations/orbit-apresentacao", label: "orbit-apresentacao" })
    expect(ref?.format).toBeUndefined()
  })

  it("sem caminho E sem nome não há card — nem botão que não abre nada", () => {
    expect(motionRefOf(part("motion_write", { html: "<html/>" }))).toBeNull()
    expect(motionRefOf(part("motion_preview", {}))).toBeNull()
  })
})
