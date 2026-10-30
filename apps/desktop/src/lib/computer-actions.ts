import type { TFunction } from "i18next"
import type { ToolPart } from "@shared/chat"

/**
 * Short sentence of what a Computer Use tool did, for the actions panel:
 * "Click element 12 · TextEdit", "Type “hi”", "Observe Safari".
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
    case "cu_verify": {
      const question = String(input.question ?? "").replace(/\s+/g, " ").trim()
      return t("computer.panels.do.verify", { question: question.length > 60 ? `${question.slice(0, 59)}…` : question }) + suffix
    }
    case "cu_permissions":
      return t("computer.panels.do.permissions")
    case "computer_task": {
      const goal = String(input.goal ?? "").replace(/\s+/g, " ").trim()
      return t("computer.panels.do.task", { goal: goal.length > 60 ? `${goal.slice(0, 59)}…` : goal })
    }
    case "cu_batch":
      return t("computer.panels.do.batch", { count: Array.isArray(input.steps) ? input.steps.length : 0 }) + suffix
    case "cu_computer": {
      const action = String(input.action ?? "")
      const find = input.find && typeof input.find === "object" ? (input.find as { text?: unknown; role?: unknown }) : null
      const target =
        input.element !== undefined
          ? t("computer.panels.target.element", { index: String(input.element) })
          : find
            ? t("computer.panels.target.find", { text: String(find.text ?? find.role ?? "") })
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

/** Tool output as text: the tools that return an object (cu_record_stop) bring the text in `message`. */
function outputText(part: ToolPart): string {
  const out = part.output ?? ""
  if (out.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(out) as { message?: unknown }
      if (typeof parsed.message === "string") return parsed.message
    } catch {
      /* it was not JSON: it goes on as text */
    }
  }
  return out
}

/**
 * What happened, in one or two lines, for the chat to show under the action:
 * the cu_computer summary (without the following observation, which is long), the app
 * line in cu_observe, the total of results in cu_query. An error comes whole.
 */
export function computerActionSummary(part: ToolPart): string | null {
  if (part.state === "error") return part.error ?? null
  const text = outputText(part).trim()
  if (!text) return null
  const lines = text.split("\n")
  switch (part.tool) {
    case "cu_computer":
      // Summary + warnings ("nothing changed") come before the blank line that opens the observation.
      return text.split("\n\n")[0].trim()
    case "cu_observe":
      return lines.find((l) => l.startsWith("App:")) ?? lines[0]
    case "cu_query":
      return lines.find((l) => /match/.test(l)) ?? lines[0]
    case "computer_task":
      // First line of the agent report (the one above is only the header).
      return lines.slice(1).find((l) => l.trim()) ?? lines[0]
    case "cu_batch": {
      // The step that stopped, or the last one that ran.
      const steps = text.split("\n\n")[0].split("\n")
      return steps.find((l) => l.includes("STOPPED")) ?? steps[steps.length - 1]
    }
    default:
      return lines[0]
  }
}

export function isComputerTool(tool: string): boolean {
  return tool.startsWith("cu_") || tool === "computer_task"
}
