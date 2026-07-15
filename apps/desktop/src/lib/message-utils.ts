import type { ChatMessage, FilePart, MessagePart, ToolPart } from "@shared/chat"

/** Ferramentas que tocam a web — alimentam chain-of-thought e fontes. */
export const WEB_TOOLS = new Set(["websearch", "webfetch", "browser_open", "browser_links"])

export interface WebSource {
  url: string
  title: string
}

export function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

/** Converte anexos do PromptInput (FileUIPart, url já em data URL) em FileParts */
export function toFileParts(files: { mediaType?: string; filename?: string; url?: string }[]): FilePart[] {
  return files
    .filter((f): f is { mediaType?: string; filename?: string; url: string } => Boolean(f.url))
    .map((f) => ({
      id: `file_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      type: "file" as const,
      mime: f.mediaType ?? "application/octet-stream",
      filename: f.filename,
      url: f.url,
    }))
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** Extrai pares Title/URL da saída textual do websearch (formato Exa). */
export function parseSearchResults(output: string): WebSource[] {
  const sources: WebSource[] = []
  let title: string | null = null
  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("Title:")) {
      title = trimmed.slice("Title:".length).trim()
    } else if (trimmed.startsWith("URL:")) {
      const url = trimmed.slice("URL:".length).trim()
      if (url.startsWith("http")) sources.push({ url, title: title ?? hostnameOf(url) })
      title = null
    }
  }
  return sources
}

function sourceOfToolPart(part: ToolPart): WebSource[] {
  if (part.state !== "done") return []
  switch (part.tool) {
    case "websearch":
      return part.output ? parseSearchResults(part.output) : []
    case "webfetch":
    case "browser_open": {
      const url = typeof part.input?.url === "string" ? part.input.url : undefined
      if (!url) return []
      // browser_open retorna "# Título\nURL: ..." na primeira linha
      const heading = part.output?.match(/^#\s+(.+)$/m)?.[1]?.trim()
      return [{ url, title: heading || hostnameOf(url) }]
    }
    default:
      return []
  }
}

/** Fontes consultadas na mensagem (deduplicadas por URL, na ordem de uso). */
export function extractSources(message: ChatMessage): WebSource[] {
  const seen = new Map<string, WebSource>()
  for (const part of message.parts) {
    if (part.type !== "tool") continue
    for (const source of sourceOfToolPart(part)) {
      if (!seen.has(source.url)) seen.set(source.url, source)
    }
  }
  return [...seen.values()]
}

export interface TestSummary {
  passed: number
  failed: number
  skipped: number
  total: number
  duration?: number
}

const TEST_COMMAND = /\b(vitest|jest|pytest|mocha|playwright test|go test|cargo test|phpunit|rspec)\b|\bnpm (?:test|t)\b|\b(?:pnpm|yarn|bun) test\b/

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

function parseDurationMs(output: string): number | undefined {
  const jest = output.match(/Time:\s+([\d.]+)\s*s/)
  if (jest) return Math.round(parseFloat(jest[1]) * 1000)
  const pytest = output.match(/in\s+([\d.]+)s\b/)
  if (pytest) return Math.round(parseFloat(pytest[1]) * 1000)
  const vitest = output.match(/Duration\s+([\d.]+)s/)
  if (vitest) return Math.round(parseFloat(vitest[1]) * 1000)
  return undefined
}

/** Extrai o resumo de execução de testes de saídas jest/vitest/pytest. */
export function parseTestSummary(output: string): TestSummary | null {
  const duration = parseDurationMs(output)

  // Jest: "Tests:       1 failed, 2 skipped, 5 passed, 8 total"
  const jest = output.match(
    /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(?:(\d+)\s+todo,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/,
  )
  if (jest) {
    const failed = Number(jest[1] ?? 0)
    const skipped = Number(jest[2] ?? 0) + Number(jest[3] ?? 0)
    const passed = Number(jest[4] ?? 0)
    return { passed, failed, skipped, total: Number(jest[5]), duration }
  }

  // Vitest: "Tests  1 failed | 5 passed | 1 skipped (7)"
  const vitest = output.match(/Tests\s+((?:\d+\s+\w+(?:\s*\|\s*)?)+)\((\d+)\)/)
  if (vitest) {
    const counts: Record<string, number> = {}
    for (const piece of vitest[1].split("|")) {
      const m = piece.trim().match(/(\d+)\s+(\w+)/)
      if (m) counts[m[2]] = Number(m[1])
    }
    return {
      passed: counts.passed ?? 0,
      failed: counts.failed ?? 0,
      skipped: counts.skipped ?? 0,
      total: Number(vitest[2]),
      duration,
    }
  }

  // Pytest: "2 failed, 3 passed, 1 skipped in 0.52s"
  const pytest = output.match(/(?:(\d+)\s+failed[,\s]+)?(\d+)\s+passed(?:[,\s]+(\d+)\s+skipped)?\s+in\s+[\d.]+s/)
  if (pytest) {
    const failed = Number(pytest[1] ?? 0)
    const passed = Number(pytest[2])
    const skipped = Number(pytest[3] ?? 0)
    return { passed, failed, skipped, total: passed + failed + skipped, duration }
  }

  return null
}
