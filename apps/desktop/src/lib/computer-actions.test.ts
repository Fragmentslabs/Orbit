import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import type { ToolPart } from "@shared/chat"
import ptBR from "@/src/i18n/locales/pt-BR.json"
import { computerActionSummary, describeAction } from "./computer-actions"

/** t mínimo sobre o locale real: confere que as chaves existem e interpolam. */
const t = ((key: string, vars: Record<string, string> = {}) => {
  let node: unknown = ptBR
  for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part]
  const text = typeof node === "string" ? node : vars.defaultValue ?? key
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? "")
}) as unknown as TFunction

const part = (tool: string, input: Record<string, unknown>): ToolPart => ({ id: "p", type: "tool", tool, state: "done", input })

describe("describeAction", () => {
  it("clique por elemento e por ponto, com o app sem o prefixo do bundle", () => {
    expect(describeAction(part("cu_computer", { action: "left_click", app: "com.apple.TextEdit", element: 12 }), t)).toBe("Clicar no elemento 12 · TextEdit")
    expect(describeAction(part("cu_computer", { action: "double_click", app: "Safari", x: 10, y: 20 }), t)).toBe("Clique duplo em (10, 20) · Safari")
  })

  it("texto, teclas e abrir app", () => {
    expect(describeAction(part("cu_computer", { action: "type", app: "com.apple.TextEdit", text: "oi" }), t)).toBe("Digitar “oi” · TextEdit")
    expect(describeAction(part("cu_computer", { action: "key", app: "TextEdit", key: "cmd+s" }), t)).toBe("Tecla cmd+s · TextEdit")
    expect(describeAction(part("cu_computer", { action: "open_app", app: "com.apple.TextEdit" }), t)).toBe("Abrir TextEdit")
  })

  it("observar, buscar e ação desconhecida", () => {
    expect(describeAction(part("cu_observe", { app: "com.apple.Safari" }), t)).toBe("Observar Safari")
    expect(describeAction(part("cu_query", { app: "Safari", text: "Entrar" }), t)).toBe("Buscar “Entrar” · Safari")
    expect(describeAction(part("cu_computer", { action: "teleport", app: "X" }), t)).toBe("teleport · X")
  })
})

describe("computerActionSummary", () => {
  const done = (tool: string, output: string): ToolPart => ({ id: "p", type: "tool", tool, state: "done", input: {}, output })

  it("cu_computer: o resumo e os avisos, sem a observação seguinte", () => {
    const out = 'Pressed element 2 (button "Salvar") via AXPress.\nNothing changed in the accessibility tree after this action.\n\nApp: TextEdit (com.apple.TextEdit, pid 1)\nWindow 9: "Doc"'
    expect(computerActionSummary(done("cu_computer", out))).toBe('Pressed element 2 (button "Salvar") via AXPress.\nNothing changed in the accessibility tree after this action.')
  })

  it("cu_observe e cu_query: a linha que diz o essencial", () => {
    expect(computerActionSummary(done("cu_observe", "App: Safari (com.apple.Safari, pid 3)\nWindow 1: x"))).toBe("App: Safari (com.apple.Safari, pid 3)")
    expect(computerActionSummary(done("cu_query", "App: X — window 1\nObservation obs_1 (…)\n2 match(es):\n<screen_content>"))).toBe("2 match(es):")
  })

  it("cu_record_stop devolve objeto: usa a mensagem", () => {
    const out = JSON.stringify({ message: "Video ready: 2.7s (recorded 9.8s, 7.1s of idle time cut).\nFile: /x.mp4", videoUrl: "orbit-video://x" })
    expect(computerActionSummary(done("cu_record_stop", out))).toBe("Video ready: 2.7s (recorded 9.8s, 7.1s of idle time cut).")
  })

  it("erro vem inteiro", () => {
    expect(computerActionSummary({ id: "p", type: "tool", tool: "cu_computer", state: "error", error: "Error (blocked): denylist" })).toBe("Error (blocked): denylist")
  })
})
