import type { TFunction } from "i18next"
import type { ToolPart } from "@shared/chat"

/**
 * Frase curta do que uma tool do Computer Use fez, para o painel de ações:
 * "Clicar no elemento 12 · TextEdit", "Digitar “oi”", "Observar Safari".
 */
export function describeAction(part: ToolPart, t: TFunction): string {
  const input = part.input ?? {}
  const app = typeof input.app === "string" ? input.app.replace(/^com\.[^.]+\./, "") : null
  const suffix = app ? ` · ${app}` : ""
  switch (part.tool) {
    case "cu_apps":
      return t("computer.panels.do.apps")
    case "cu_observe":
      return t("computer.panels.do.observe", { app: app ?? "?" })
    case "cu_query":
      return t("computer.panels.do.query", { text: String(input.text ?? input.role ?? "") }) + suffix
    case "cu_permissions":
      return t("computer.panels.do.permissions")
    case "cu_computer": {
      const action = String(input.action ?? "")
      const target =
        input.element !== undefined
          ? t("computer.panels.target.element", { index: String(input.element) })
          : input.x !== undefined
            ? t("computer.panels.target.point", { x: String(input.x), y: String(input.y) })
            : ""
      if (action === "type" || action === "set_value" || (action === "select_text" && input.text)) {
        const text = String(input.text ?? "")
        return t(`computer.panels.do.${action}`, { text: text.length > 40 ? `${text.slice(0, 39)}…` : text }) + suffix
      }
      if (action === "key") return t("computer.panels.do.key", { key: String(input.key ?? "") }) + suffix
      if (action === "wait") return t("computer.panels.do.wait", { seconds: String(input.seconds ?? 1) })
      if (action === "open_app") return t("computer.panels.do.open_app", { app: app ?? "?" })
      if (action === "scroll") return t("computer.panels.do.scroll", { direction: String(input.direction ?? "down") }) + suffix
      return `${t(`computer.panels.do.${action}`, { defaultValue: action })}${target ? ` ${target}` : ""}${suffix}`
    }
  }
  return part.tool
}

/** Saída da tool em texto: as tools que devolvem objeto (cu_record_stop) trazem o texto em `message`. */
function outputText(part: ToolPart): string {
  const out = part.output ?? ""
  if (out.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(out) as { message?: unknown }
      if (typeof parsed.message === "string") return parsed.message
    } catch {
      /* não era JSON: segue como texto */
    }
  }
  return out
}

/**
 * O que aconteceu, em uma ou duas linhas, para o chat mostrar embaixo da ação:
 * o resumo do cu_computer (sem a observação seguinte, que é longa), a linha do
 * app no cu_observe, o total de resultados no cu_query. Erro vem inteiro.
 */
export function computerActionSummary(part: ToolPart): string | null {
  if (part.state === "error") return part.error ?? null
  const text = outputText(part).trim()
  if (!text) return null
  const lines = text.split("\n")
  switch (part.tool) {
    case "cu_computer":
      // Resumo + avisos ("nada mudou") vêm antes da linha em branco que abre a observação.
      return text.split("\n\n")[0].trim()
    case "cu_observe":
      return lines.find((l) => l.startsWith("App:")) ?? lines[0]
    case "cu_query":
      return lines.find((l) => /match/.test(l)) ?? lines[0]
    default:
      return lines[0]
  }
}

export function isComputerTool(tool: string): boolean {
  return tool.startsWith("cu_")
}
