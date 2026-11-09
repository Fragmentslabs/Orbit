import type { ChatMessage, MessagePart, ToolPart } from "@shared/chat"

/**
 * What a worker is doing right now, read from its own chat. The orchestra's strip shows one
 * line per worker, and this is that line: the stretch of the answer being written, the tool
 * in use, or the thought in progress. Pure, so the strip stays a view over the messages.
 */
export type WorkerActivityKind = "idle" | "thinking" | "tool" | "writing"

export interface WorkerActivity {
  kind: WorkerActivityKind
  /** One short line. For `idle` it is what the worker last said (its result), if anything. */
  text: string
}

const LINE_MAX = 140

/** Inputs worth showing next to a tool name, in order of how much they say. */
const HINT_KEYS = ["query", "pattern", "path", "filePath", "file", "url", "command", "name"] as const

function oneLine(text: string, tail = false): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= LINE_MAX) return flat
  return tail ? `…${flat.slice(-LINE_MAX)}` : `${flat.slice(0, LINE_MAX)}…`
}

function toolLine(part: ToolPart): string {
  const name = part.title?.trim() || part.tool
  for (const key of HINT_KEYS) {
    const value = part.input?.[key]
    if (typeof value === "string" && value.trim()) return oneLine(`${name} · ${value}`)
  }
  return oneLine(name)
}

function lastText(parts: MessagePart[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.type === "text" && !part.source && part.text.trim()) return oneLine(part.text)
  }
  return ""
}

export function workerActivity(messages: ChatMessage[] | undefined): WorkerActivity {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === "assistant")
  if (!last) return { kind: "idle", text: "" }
  // A finished message (completed or failed) is a result, not an activity.
  const finished = last.completedAt !== undefined || last.error !== undefined
  if (!finished) {
    for (let i = last.parts.length - 1; i >= 0; i--) {
      const part = last.parts[i]
      if (part.type === "tool" && part.state === "running") return { kind: "tool", text: toolLine(part) }
      if (part.type === "reasoning" && part.state === "streaming") return { kind: "thinking", text: oneLine(part.text, true) }
      if (part.type === "text" && part.state === "streaming" && !part.source && part.text.trim()) {
        return { kind: "writing", text: oneLine(part.text, true) }
      }
    }
  }
  return { kind: "idle", text: lastText(last.parts) }
}
