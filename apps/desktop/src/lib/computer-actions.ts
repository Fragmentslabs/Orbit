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
      if (action === "type" || action === "set_value") {
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
